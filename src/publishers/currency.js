'use strict'

const lib = require('xrpl-accountlib')
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
      async publish(Connection, data, sequence) {
        if (!('rawResultsNamed' in data)) { return }
        dotenv.config()

        log(`START (timeout at ${timeoutSec}), GO GET DATA!`)

        log('GOT DATA')
        log({data})

        // await Connection

        const Memos = Object.keys(data.rawResultsNamed).map(k => {
          return {
            Memo: {
              MemoData: Buffer.from(data.rawResultsNamed[k].map(_v => String(_v)).join(';'), 'utf-8').toString('hex').toUpperCase(),
              MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
              MemoType: Buffer.from('rates:' + k, 'utf-8').toString('hex').toUpperCase()
            }
          }
        })

        // const { account_data } = await Connection.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })

        let filteredMedian = String(data.filteredMedian)
        const exp = filteredMedian.split('.')
        if (exp.length == 2) {
          filteredMedian = exp[0] + '.' + exp[1].substring(0, 10)
        }
        
        const Tx = {
          TransactionType: 'TrustSet',
          Account: process.env.XRPL_SOURCE_ACCOUNT,
          Fee: '10',
          Flags: 131072,
          Sequence: sequence,
          LimitAmount: {
            currency: data.symbol.substring('XRP/'.length),
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: filteredMedian
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

        log('WRAP UP')
        //;(await Connection).close()
        clearTimeout(timeout)
      }
    })
  }
}