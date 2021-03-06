import { expect } from 'chai'
import Web3 from 'web3'
import getETHBalance from './getWeiBalance';
import Currency from 'connext/dist/lib/currency/Currency';

describe('getETHBalance', () => {
  it('should get balance from web3', async () => {
    const web3 = new Web3()

    const WEI_BALANCE = 69
    const address = '0x0'

    const getBalance = (passedInAddress: string, latest: 'lastest', cb: Function) => {
      expect(passedInAddress).equals(address)
      expect(latest).equals('latest')
      cb(null, WEI_BALANCE)
    }

    web3.eth.getBalance = getBalance as any

    expect(Currency.equals(
      await getETHBalance(web3, address),
      Currency.WEI(WEI_BALANCE),
    )).equals(true)
  })
})
