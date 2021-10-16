'use strict'

const { XrplClient } = require('xrpl-client')
const lib = require('xrpl-accountlib')
const Conn = require('rippled-ws-client')
const Sign = require('rippled-ws-client-sign')
const debug = require( 'debug')
const dotenv = require('dotenv')

const log = debug('oracle:publish')
const timeoutSec = (process.env.TIMEOUT_SECONDS || 55)
const timeout = setTimeout(() => {
  log(`Error, killed by timeout after ${timeoutSec} seconds`)
  process.exit(1)
}, timeoutSec * 1000)

module.exports = class CurrencyPublisher {
  constructor() {
    Object.assign(this, {
      async publish(data) {
        if (!('rawResultsNamed' in data)) { return }
        dotenv.config()

        const Connection = new XrplClient(process.env.ENDPOINT)

        log(`START (timeout at ${timeoutSec}), GO GET DATA!`)

        log('GOT DATA')
        log({data})

        await Connection

        const Memos = Object.keys(data.rawResultsNamed).map(k => {
          return {
            Memo: {
              MemoData: Buffer.from(data.rawResultsNamed[k].map(_v => String(_v)).join(';'), 'utf-8').toString('hex').toUpperCase(),
              MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
              MemoType: Buffer.from('rates:' + k, 'utf-8').toString('hex').toUpperCase()
            }
          }
        })

        const { account_data } = await Connection.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })

        const Tx = {
          TransactionType: 'TrustSet',
          Account: process.env.XRPL_SOURCE_ACCOUNT,
          Fee: '10',
          Flags: 131072,
          Sequence: account_data.Sequence,
          LimitAmount: {
            currency: data.symbol.substring('XRP/'.length),
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: String(data.filteredMedian)
          },
          Memos
        }
        log(Tx)

        log('SIGN & SUBMIT')
        try {
          

          const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
          const {signedTransaction} = lib.sign(Tx, keypair)
          const Signed = await Connection.send({ command: 'submit', 'tx_blob': signedTransaction })

          log({Signed})
        } catch (e) {
          log(`Error signing / submitting: ${e.message}`)
        }

        if (typeof process.env.ENDPOINT_TESTNET !== 'undefined') {
          log('SIGN & SUBMIT TESTNET')

          try {
            const ConnectionTestnet = new XrplClient(process.env.ENDPOINT_TESTNET)
            const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
            const {signedTransaction} = lib.sign(Tx, keypair)
            const SignedTestnet = await ConnectionTestnet.send({ command: 'submit', 'tx_blob': signedTransaction })

            log({SignedTestnet})
          } catch (e) {
            log(`Error signing / submitting @ Testnet: ${e.message}`)
          }
          ;(await ConnectionTestnet).close()
        }

        log('WRAP UP')
        ;(await Connection).close()
        clearTimeout(timeout)
      }
    })
  }
}