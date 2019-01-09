import { BigNumber } from 'bignumber.js'
import { ChannelUpdateReasons, ChannelState, convertChannelState, PaymentArgs, ConfirmPendingArgs } from 'connext/dist/types'
import { Utils } from 'connext/dist/Utils'
import { StateGenerator } from 'connext/dist/StateGenerator'
import { EventLog } from 'web3/types'
import { Lock } from './util'
import ChainsawDao from './dao/ChainsawDao'
import log from './util/log'
import { ContractEvent, DidHubContractWithdrawEvent, DidUpdateChannelEvent } from './domain/ContractEvent'
import Config from './Config'
import { ChannelManager } from './ChannelManager'
import ChannelsDao from './dao/ChannelsDao'
import abi from './abi/ChannelManager'
import { sleep } from './util'
import { default as DBEngine } from './DBEngine'

const LOG = log('ChainsawService')

const CONFIRMATION_COUNT = 3
const POLL_INTERVAL = 1000

interface WithBalances {
  balanceWeiHub: BigNumber
  balanceTokenHub: BigNumber
  balanceWeiUser: BigNumber
  balanceTokenUser: BigNumber
}

export default class ChainsawService {
  private chainsawDao: ChainsawDao

  private web3: any

  private contract: ChannelManager

  private channelsDao: ChannelsDao

  private utils: Utils

  private hubAddress: string

  private config: Config

  private db: DBEngine

  private stateGenerator: StateGenerator

  constructor(chainsawDao: ChainsawDao, channelsDao: ChannelsDao, web3: any, utils: Utils, config: Config, db: DBEngine, stateGenerator: StateGenerator) {
    this.chainsawDao = chainsawDao
    this.channelsDao = channelsDao
    this.utils = utils
    this.web3 = web3
    this.contract = new this.web3.eth.Contract(abi, config.channelManagerAddress) as ChannelManager
    this.hubAddress = config.hotWalletAddress
    this.config = config
    this.db = db
    this.stateGenerator = stateGenerator
  }

  async poll() {
    while (true) {
      const start = Date.now()

      await this.pollOnce()

      const elapsed = start - Date.now()
      if (elapsed < POLL_INTERVAL)
        await sleep(POLL_INTERVAL - elapsed)
    }
  }

  async pollOnce() {
    try {
      await this.db.withTransaction(() => this.doFetchEvents())
    } catch (e) {
      LOG.error('Fetching events failed: {e}', { e })
    }

    try {
      await this.db.withTransaction(() => this.doProcessEvents())
    } catch (e) {
      LOG.error('Processing events failed: {e}', { e })
    }
  }

  private async doFetchEvents() {
    const topBlock = await this.web3.eth.getBlockNumber()
    const last = await this.chainsawDao.lastPollFor(this.contract._address, 'FETCH_EVENTS')
    const lastBlock = last.blockNumber
    const toBlock = topBlock - CONFIRMATION_COUNT

    // need to check for >= here since we were previously not checking for a confirmation count
    if (lastBlock >= toBlock) {
      return
    }

    const fromBlock = lastBlock + 1

    LOG.info('Synchronizing chain data between blocks {fromBlock} and {toBlock}', {
      fromBlock,
      toBlock
    })

    const events = await this.contract.getPastEvents('allEvents', {
      fromBlock,
      toBlock
    })

    const blockIndex = {} as any
    const txsIndex = {} as any

    events.forEach((e: EventLog) => {
      blockIndex[e.blockNumber] = true
      txsIndex[e.transactionHash] = true
    })

    await Promise.all(Object.keys(blockIndex).map(async (n: string) => {
      blockIndex[n] = await this.web3.eth.getBlock(n)
    }))

    await Promise.all(Object.keys(txsIndex).map(async (txHash: string) => {
      txsIndex[txHash] = await this.web3.eth.getTransaction(txHash)
    }))

    const channelEvents: ContractEvent[] = events.map((log: EventLog) => {
      return ContractEvent.fromRawEvent({
        log: log,
        txIndex: log.transactionIndex,
        logIndex: log.logIndex,
        contract: this.contract._address,
        sender: txsIndex[log.transactionHash].from,
        timestamp: blockIndex[log.blockNumber].timestamp * 1000
      })
    })

    if (channelEvents.length) {
      LOG.info('Inserting new transactions: {transactions}', {
        transactions: channelEvents.map((e: ContractEvent) => e.txHash)
      })
      await this.chainsawDao.recordEvents(channelEvents, toBlock, this.contract._address)
      LOG.info('Successfully inserted {num} transactions.', {
        num: channelEvents.length
      })
    } else {
      LOG.info('No new transactions found; nothing to do.')
      await this.chainsawDao.recordPoll(toBlock, null, this.contract._address, 'FETCH_EVENTS')
    }
  }

  private async doProcessEvents() {
    const last = await this.chainsawDao.lastPollFor(this.contract._address, 'PROCESS_EVENTS')
    const ingestedEvents = await this.chainsawDao.eventsSince(this.contract._address, last.blockNumber, last.txIndex)

    if (!ingestedEvents.length) {
      return
    }

    for (let i = 0; i < ingestedEvents.length; i++) {
      let event = ingestedEvents[i]

      switch (event.event.TYPE) {
        case DidHubContractWithdrawEvent.TYPE:
          break
        case DidUpdateChannelEvent.TYPE:
          await this.processDidUpdateChannel(event.id, event.event as DidUpdateChannelEvent)
          break
        default:
          LOG.info('Got type {type}. Not implemented yet.', {
            type: event.event.TYPE
          })
      }
    }
  }

  private async processDidUpdateChannel(chainsawId: number, event: DidUpdateChannelEvent) {
    if (event.txCountGlobal > 1) {
      const knownEvent = await this.channelsDao.getChannelUpdateByTxCount(event.user, event.txCountGlobal)
      if (!knownEvent) {
        // This means there is an event on chain which we don't have a copy of
        // in our database. This is a Very Big Problem, so crash hard here
        // and handle it manually.
        LOG.error('CRITICAL: Event broadcast on chain, but not found in the database. This should never happen! Event body: {event}', { event: JSON.stringify(event) })
        if (this.config.isProduction)
          throw new Error('Event broadcast on chain, but not found in the database! THIS IS PROBABLY BAD! See comments in code.')
        return
      }
    }

    const prev = await this.channelsDao.getChannelOrInitialState(event.user)
    const state = this.stateGenerator.confirmPending(convertChannelState('bn', prev.state))
    const hash = this.utils.createChannelStateHash(state)
    const sigHub = await this.web3.eth.sign(hash, this.hubAddress)
    await this.channelsDao.applyUpdateByUser(event.user, 'ConfirmPending', this.hubAddress, {
      ...state,
      sigHub
    } as ChannelState, { transactionHash: event.txHash } as ConfirmPendingArgs, chainsawId)
    await this.chainsawDao.recordPoll(event.blockNumber, event.txIndex, this.contract._address, 'PROCESS_EVENTS')
  }
}
