'use strict'

const lib = require('xrpl-accountlib')
const debug = require( 'debug')
const dotenv = require('dotenv')

const log = debug('oracle:publish')
const errlog = debug('oracle:error')

module.exports = class CurrencyPublisher {
  constructor() {
    Object.assign(this, {
      async publish(Connection, data, sequence, fee, count, stats, oracle) {
        let retry = null

        if (!('rawResultsNamed' in data)) { return }
        dotenv.config()

        log('GOT DATA')
        log({data})

        const Memos = Object.keys(data.rawResultsNamed).map(k => {
          return {
            Memo: {
              MemoData: Buffer.from(data.rawResultsNamed[k].map(_v => String(_v)).join(';'), 'utf-8').toString('hex').toUpperCase(),
              MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
              MemoType: Buffer.from('rates:' + k, 'utf-8').toString('hex').toUpperCase()
            }
          }
        })

        let filteredMedian = String(data.filteredMedian)
        const exp = filteredMedian.split('.')
        if (exp.length == 2) {
          filteredMedian = exp[0] + '.' + exp[1].substring(0, 10)
        }
        
        let code = data.symbol.substring('XRP/'.length)
        if (code.length > 3) {
          code = this.currencyUTF8ToHex(code)
        }
        const Tx = {
          TransactionType: 'TrustSet',
          Account: process.env.XRPL_SOURCE_ACCOUNT,
          Fee: (fee + count).toString(),
          Flags: 131072,
          Sequence: sequence,
          LimitAmount: {
            currency: code,
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: filteredMedian
          },
          Memos
        }
        // log(Tx)

        log('SIGN & SUBMIT')
        try {
          const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
          const {signedTransaction} = lib.sign(Tx, keypair)
          const Signed = await Connection.send({ command: 'submit', 'tx_blob': signedTransaction })

          log({Signed})
          if (Signed.engine_result != 'tesSUCCESS') {
            stats.last_error = Signed.engine_result
            retry = this.resubmitTx(data, oracle)
          }
          else {
            log('Signed ' + data.symbol)
            stats.last_published = new Date()
            stats.submissions_since_start ++
          }
        } catch (e) {
          errlog(`Error signing / submitting: ${e.message}`)
          retry = this.resubmitTx(data, oracle)
        }
        log('WRAP UP')
      },
      resubmitTx(data, oracle) {
        // make sure a stuck transaction at somepoint falls off our queue
        if (!('maxRetry' in data)) {
          data.maxRetry = 0
        }
        data.maxRetry++
        if (data.maxRetry <= 3) {
          oracle.retryPublish(data)
          errlog('RESUBMIT: ' + data.symbol)
        }
      },
      currencyUTF8ToHex(code){
        if(/^[a-zA-Z0-9\?\!\@\#\$\%\^\&\*\<\>\(\)\{\}\[\]\|\]\{\}]{3}$/.test(code))
          return code
    
        if(/^[A-Z0-9]{40}$/.test(code))
          return code
    
        let hex = ''
    
        for(let i=0; i<code.length; i++){
          hex += code.charCodeAt(i).toString(16)
        }
    
        return hex.toUpperCase().padEnd(40, '0')
      }
    })
  }
}