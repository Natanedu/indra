import Web3 from 'web3'
import * as w3utils from 'web3-utils';
import { Networking } from './helpers/networking'
import { getLastThreadUpdateId } from './lib/getLastThreadUpdateId';
import { ExchangeRates } from './state/ConnextState/ExchangeRates'
import {
  Address,
  ChannelRow,
  ChannelState,
  ChannelStateUpdate,
  channelUpdateToUpdateRequest,
  HubConfig,
  Payment,
  PurchasePayment,
  PurchasePaymentHubResponse,
  SignedDepositRequestProposal,
  Sync,
  ThreadRow,
  ThreadState,
  ThreadStateUpdate,
  UpdateRequest,
  WithdrawalParameters,
} from './types'

/*********************************
 ****** CONSTRUCTOR TYPES ********
 *********************************/

export interface IHubAPIClient {
  authChallenge(): Promise<string>
  authResponse(nonce: string, address: string, origin: string, signature: string): Promise<string>
  getAuthStatus(): Promise<{ success: boolean, address?: Address }>
  getAuthToken(): Promise<string>
  getChannel(): Promise<ChannelRow>
  getChannelByUser(user: Address): Promise<ChannelRow>
  getChannelStateAtNonce(txCountGlobal: number): Promise<ChannelStateUpdate>
  getThreadInitialStates(): Promise<ThreadState[]>
  getIncomingThreads(): Promise<ThreadRow[]>
  getActiveThreads(): Promise<ThreadState[]>
  getLastThreadUpdateId(): Promise<number>
  getAllThreads(): Promise<ThreadState[]>
  getThreadByParties(partyB: Address, userIsSender: boolean): Promise<ThreadRow>
  sync(txCountGlobal: number, lastThreadUpdateId: number): Promise<Sync | null>
  getExchangerRates(): Promise<ExchangeRates> // TODO: name is typo
  buy<PurchaseMetaType=any, PaymentMetaType=any>(
    meta: PurchaseMetaType,
    payments: PurchasePayment<PaymentMetaType>[],
  ): Promise<PurchasePaymentHubResponse>
  requestDeposit(deposit: SignedDepositRequestProposal, txCount: number, lastThreadUpdateId: number): Promise<Sync>
  requestWithdrawal(withdrawal: WithdrawalParameters, txCountGlobal: number): Promise<Sync>
  requestExchange(weiToSell: string, tokensToSell: string, txCountGlobal: number): Promise<Sync>
  requestCollateral(txCountGlobal: number): Promise<Sync>
  updateHub(updates: UpdateRequest[], lastThreadUpdateId: number): Promise<{
    error: string | null
    updates: Sync
  }>
  updateThread(update: ThreadStateUpdate): Promise<ThreadStateUpdate>
  getLatestChannelStateAndUpdate(): Promise<{state: ChannelState, update: UpdateRequest} | null>
  getLatestStateNoPendingOps(): Promise<ChannelState | null>
  config(): Promise<HubConfig>
  redeem(secret: string, txCount: number, lastThreadUpdateId: number,): Promise<PurchasePaymentHubResponse & { amount: Payment }>
}

export class HubAPIClient implements IHubAPIClient {
  private user: Address
  private networking: Networking
  private web3: Web3
  private origin: string
  private authToken?: string

  constructor(user: Address, networking: Networking, web3: Web3, origin: string) {
    this.user = user.toLowerCase()
    this.networking = networking
    this.web3 = web3
    this.origin = origin
  }

  async config(): Promise<HubConfig> {
    const res = (await this.networking.get(`config`)).data
    return res ? res : null
  }

  async authChallenge(): Promise<string> {
    const res = (await this.networking.post(`auth/challenge`, {})).data
    return res && res.nonce ? res.nonce : null
  }

  async authResponse(nonce: string, address: string, origin: string, signature: string): Promise<string> {
    const res = (await this.networking.post(`auth/response`, {
      nonce,
      address,
      origin,
      signature,
    })).data
    return res && res.token ? res.token : null
  }

  async getAuthStatus(): Promise<{ success: boolean, address?: Address }> {
    const res = (await this.networking.post(`auth/status`, {
      authToken: this.authToken
    })).data
    return res ? res : { success: false }
  }

  async getAuthToken(): Promise<string> {
    // if we already have an auth token that works, return it
    const status = await this.getAuthStatus()
    if (this.authToken && status.success && status.address && status.address.toLowerCase() == this.user) {
      return this.authToken
    }
    console.log(`Getting a new auth token, current one is invalid: ${this.authToken}`)

    // reset authtoken
    const nonce = await this.authChallenge()

    // create hash and sign
    const preamble = "SpankWallet authentication message:";
    const hash = this.web3.utils.sha3(`${preamble} ${this.web3.utils.sha3(nonce)} ${this.web3.utils.sha3(this.origin)}`);
    const signature = await (this.web3.eth.personal.sign as any)(hash, this.user);

    // set auth token
    this.authToken = await this.authResponse(nonce, this.user, this.origin, signature)
    // document.cookie = `hub.sid=${authToken}`; // Think the browser will set this for us
    return this.authToken
  }

  async getLatestStateNoPendingOps(): Promise<ChannelState | null> {
    try {
      const res = (await this.networking.post(`channel/${this.user}/latest-no-pending`, {
        authToken: await this.getAuthToken(),
      })).data
      return res ? res : null
    } catch (e) {
      if (e.status == 404) {
        console.log(`Channel not found for user ${this.user}`)
        return null
      }
      console.log('Error getting latest state no pending ops:', e)
      throw e
    }
  }

  async getLastThreadUpdateId(): Promise<number> {
    try {
      const res = (await this.networking.post(`thread/${this.user}/last-update-id`, {
        authToken: await this.getAuthToken(),
      })).data
      return res && res.latestThreadUpdateId ? res.latestThreadUpdateId : 0
    } catch (e) {
      if (e.status == 404) {
        console.log(`Thread update not found for user ${this.user}`)
        return 0
      }
      console.log('Error getting latest state no pending ops:', e)
      throw e
    }
  }

  async getLatestChannelStateAndUpdate(): Promise<{state: ChannelState, update: UpdateRequest} | null> {
    try {
      const res = (await this.networking.post(`channel/${this.user}/latest-update`, {
        authToken: await this.getAuthToken(),
      })).data
      return res && res.state ? { state: res.state, update: channelUpdateToUpdateRequest(res) } : null
    } catch (e) {
      if (e.status == 404) {
        console.log(`Channel not found for user ${this.user}`)
        return null
      }
      console.log('Error getting latest state:', e)
      throw e
    }
  }

  // 'POST /:sender/to/:receiver/update': 'doUpdateThread'
  async updateThread(update: ThreadStateUpdate): Promise<ThreadStateUpdate> {
    try {
      const res = (await this.networking.post(`thread/${update.state.sender}/to/${update.state.receiver}/update`, {
        authToken: await this.getAuthToken(),
        update,
      })).data
      return res ? res : null
    } catch (e) {
      if (e.statusCode === 404) {
        throw new Error(`Thread not found for sender ${update.state.sender} and receiver ${update.state.receiver}`)
      }
      throw e
    }
  }

  // get the current channel state and return it
  async getChannelByUser(user: Address): Promise<ChannelRow> {
    try {
      const res = (await this.networking.post(`channel/${user}`, {
        authToken: await this.getAuthToken(),
      })).data
      return res ? res : null
    } catch (e) {
      if (e.statusCode === 404) {
        throw new Error(`Channel not found for user ${user}`)
      }
      throw e
    }
  }

  async getChannel(): Promise<ChannelRow> {
    return await this.getChannelByUser(this.user)
  }

  // return channel state at specified global nonce
  async getChannelStateAtNonce(
    txCountGlobal: number,
  ): Promise<ChannelStateUpdate> {
    try {
      const res = (await this.networking.post(`channel/${this.user}/update/${txCountGlobal}`, {
        authToken: await this.getAuthToken(),
      })).data
      return res ? res : null
    } catch (e) {
      throw new Error(
        `Cannot find update for user ${this.user} at nonce ${txCountGlobal}, ${e.toString()}`
      )
    }
  }

  // get the current channel state and return it
  async getThreadInitialStates(): Promise<ThreadState[]> {
    const res = (await this.networking.post(`thread/${this.user}/initial-states`, {
      authToken: await this.getAuthToken(),
    })).data
    return res ? res : []
  }

  // get the current channel state and return it
  async getActiveThreads(): Promise<ThreadState[]> {
    const res = (await this.networking.post(`thread/${this.user}/active`, {
      authToken: await this.getAuthToken(),
    })).data
    return res ? res : []
  }

  // get the current channel state and return it
  async getAllThreads(): Promise<ThreadState[]> {
    const res = (await this.networking.post(`thread/${this.user}/all`, {
      authToken: await this.getAuthToken(),
    })).data
    return res ? res : []
  }

  // get the current channel state and return it
  async getIncomingThreads(): Promise<ThreadRow[]> {
    const res = (await this.networking.post(`thread/${this.user}/incoming`, {
      authToken: await this.getAuthToken(),
    })).data
    return res ? res : []
  }

  // return all threads between 2 addresses
  async getThreadByParties(
    partyB: Address,
    userIsSender: boolean,
  ): Promise<ThreadRow> {
    // get receiver threads
    const res = (await this.networking.post(
      `thread/${userIsSender ? this.user : partyB}/to/${userIsSender ? partyB : this.user}`,
      { authToken: await this.getAuthToken() }
    )).data
    return res ? res : null
  }

  // hits the hubs sync endpoint to return all actionable states
  async sync(
    txCountGlobal: number,
    lastThreadUpdateId: number
  ): Promise<Sync | null> {
    try {
      const res = (await this.networking.post(
        `channel/${this.user}/sync?lastChanTx=${txCountGlobal}&lastThreadUpdateId=${lastThreadUpdateId}`,
        { authToken: await this.getAuthToken() }
      )).data
      return res ? res : null
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      throw e
    }
  }

  async getExchangerRates(): Promise<ExchangeRates> {
    const res = (await this.networking.get('exchangeRate')).data
    return res && res.rates ? res.rates : null
  }

  async buy<PurchaseMetaType=any, PaymentMetaType=any>(
    meta: PurchaseMetaType,
    payments: PurchasePayment<PaymentMetaType>[],
  ): Promise<PurchasePaymentHubResponse> {
    try {
      const res = (await this.networking.post('payments/purchase', {
        authToken: await this.getAuthToken(),
        meta,
        payments,
      })).data
      return res ? res : null
    } catch (e) {
      throw e
    }
  }

  async redeem(secret: string, txCount: number, lastThreadUpdateId: number,): Promise<PurchasePaymentHubResponse & { amount: Payment}> {
    try {
      const res = (await this.networking.post(`payments/redeem/${this.user}`, {
        authToken: await this.getAuthToken(),
        secret,
        lastChanTx: txCount,
        lastThreadUpdateId,
      })).data
      return res ? res : null
    } catch (e) {
      console.log(e.message)
      if (e.message.indexOf("Payment has been redeemed.") != -1) {
        throw new Error(`Payment has been redeemed.`)
      }
      throw e
    }
  }

  // post to hub telling user wants to deposit
  async requestDeposit(
    deposit: SignedDepositRequestProposal,
    txCount: number,
    lastThreadUpdateId: number,
  ): Promise<Sync> {
    if (!deposit.sigUser) {
      throw new Error(`No signature detected on the deposit request. Deposit: ${deposit}, txCount: ${txCount}, lastThreadUpdateId: ${lastThreadUpdateId}`)
    }
    const res = (await this.networking.post(`channel/${this.user}/request-deposit`, {
      authToken: await this.getAuthToken(),
      depositWei: deposit.amountWei,
      depositToken: deposit.amountToken,
      sigUser: deposit.sigUser,
      lastChanTx: txCount,
      lastThreadUpdateId,
    })).data
    return res ? res : null
  }

  // post to hub telling user wants to withdraw
  async requestWithdrawal(
    withdrawal: WithdrawalParameters,
    txCountGlobal: number
  ): Promise<Sync> {
    const res = (await this.networking.post(`channel/${this.user}/request-withdrawal`, {
      authToken: await this.getAuthToken(),
      lastChanTx: txCountGlobal,
      ...withdrawal,
    })).data
    return res ? res : null
  }

  async requestExchange(weiToSell: string, tokensToSell: string, txCountGlobal: number): Promise<Sync> {
    const res = (await this.networking.post(`channel/${this.user}/request-exchange`, {
      authToken: await this.getAuthToken(),
      weiToSell,
      tokensToSell,
      lastChanTx: txCountGlobal,
    })).data
    return res ? res : null
  }

  // performer calls this when they wish to start a show
  // return the proposed deposit fro the hub which should then be verified and cosigned
  async requestCollateral(txCountGlobal: number): Promise<Sync> {
    const res = (await this.networking.post(`channel/${this.user}/request-collateralization`, {
      authToken: await this.getAuthToken(),
      lastChanTx: txCountGlobal,
    })).data
    return res ? res : null
  }

  // post to hub to batch verify state updates
  async updateHub(
    updates: UpdateRequest[],
    lastThreadUpdateId: number,
  ): Promise<{ error: string | null, updates: Sync }> {
    const res = (await this.networking.post(`channel/${this.user}/update`, {
      authToken: await this.getAuthToken(),
      lastThreadUpdateId,
      updates,
    })).data
    return res ? res : null
  }

}