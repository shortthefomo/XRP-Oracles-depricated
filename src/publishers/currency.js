'use strict'

const lib = require('xrpl-accountlib')
const dotenv = require('dotenv')
const logger = require('../logger.js');

module.exports = class CurrencyPublisher {
  constructor() {
    Object.assign(this, {
      async publish(Connection, data, sequence, oracle) {
        let retry = null

        if (!('rawResultsNamed' in data)) { return }
        dotenv.config()

        logger.debug('GOT DATA')
        logger.debug({data})

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
          Fee: process.env.XRPL_FEE == null ? '10' : process.env.XRPL_FEE,
          Flags: 131072,
          Sequence: sequence,
          LimitAmount: {
            currency: code,
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: filteredMedian
          },
          Memos
        }
        // logger.debug(Tx)

        logger.debug('SIGN & SUBMIT')
        try {
          const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
          const {signedTransaction} = lib.sign(Tx, keypair)
          const Signed = await Connection.send({ command: 'submit', 'tx_blob': signedTransaction })

          // logger.debug({Signed})
          if (Signed.engine_result != 'tesSUCCESS') {
            retry = this.resubmitTx(data, oracle)  
          }
          else {
            logger.debug('Signed ' + data.symbol)
            data.transactionHash = Signed.tx_json.hash
          }
        } catch (e) {
          logger.error(`Error signing / submitting: ${e.message}`)
          retry = this.resubmitTx(data, oracle)
        }
        logger.debug('WRAP UP')
      },
      resubmitTx(data, oracle) {
        // make sure a stuck transaction at somepoint falls off our queue
        if (!('maxRetry' in data)) {
          data.maxRetry = 0
        }
        data.maxRetry++
        if (data.maxRetry <= 3) {
          oracle.retryPublish(data)
          logger.warn('RESUBMIT: ' + data.symbol)
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