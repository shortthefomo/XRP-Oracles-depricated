'use strict'

const { XrplClient } = require('xrpl-client')
const app = require('express')()
const express = require('express')
const path = require( 'path')
const https = require('https')
const http = require('http')
const fs = require( 'fs')
const debug = require( 'debug')
const aggregator = require('xrp-price-aggregator')
const stats = require('stats-analysis')
const currency = require('./publishers/currency.js') 
const dotenv = require('dotenv')
const axios = require('axios')
const EventEmitter = require('events')

// const rootCas = require('ssl-root-cas').create()

// rootCas.addFile(path.resolve(__dirname, process.env.CERT))
// rootCas.addFile(path.resolve(__dirname, process.env.KEY))

// require('https').globalAgent.options.ca = require('ssl-root-cas').create()

const log = debug('oracle:main')
const userlog = debug('oracle:user')

dotenv.config()

// let httpsServer = null
// if (process.env.CERT != null) {
//   log('using https: for webhead: ' + process.env.SSLPORT)
//   const sslOptions = {
//       cert: fs.readFileSync(__dirname + process.env.CERT, 'utf8'),
//       key: fs.readFileSync(__dirname + process.env.KEY, 'utf8'),
//       ca: [
//         fs.readFileSync(__dirname + process.env.BUNDLE, 'utf8')
//       ]
//   }
//   httpsServer = https.createServer(sslOptions, app).listen(process.env.SSLPORT)   
// }

log('using http: for webhead: ' + (process.env.PORT))
const httpServer = http.createServer(app).listen(process.env.PORT)

class Oracle extends EventEmitter {
  constructor(Config) {
    super()

    let fifo = []
    let retry = []
    const baseUrl = process.env.BASEURL
    const feedUrl = baseUrl + '/api/feed/data'
    const client = new XrplClient(process.env.ENDPOINT)
    let oracleData = []

    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(feedUrl, oracle).run())
        })
      },
      async start() {
        this.oracleFeed()
        this.startEventLoop()
        this.listenEventLoop()
        await client

        client.on('ledger', async (event) =>  {
          if (event.type == 'ledgerClosed') {
            const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
            //log(account_data)
            if (account_data != null && 'Sequence' in account_data) {
              this.processFifo(account_data.Sequence)  
            }
          }
        })
        client.on('message', (event) => {
            this.getOracleData(event)
        })
      },
      getOracleData(event) {
        if (!('engine_result' in event)) { return }
        if (!('transaction' in event)) { return }
        if (!('TransactionType' in event.transaction)) { return }
        if (!('Memos' in event.transaction)) { return }
        if (!('Account' in event.transaction)) { return }
        if (!('LimitAmount' in event.transaction)) { return }

        if (event.engine_result != 'tesSUCCESS') { return }
        if (event.transaction.TransactionType != 'TrustSet') { return }
        

        const results = {
          limited_amount: event.transaction.LimitAmount, 
          ledger_index: event.ledger_index,
          oracle: event.transaction.Account,
          'meta': []
        }
        for (var i = 0; i < event.transaction.Memos.length; i++) {
          const result = { source: '', rates: [] }

          const sMemoType = Buffer.from(event.transaction.Memos[i].Memo.MemoType, 'hex').toString('utf8').split(':')
          const sMemoData = Buffer.from(event.transaction.Memos[i].Memo.MemoData, 'hex').toString('utf8').split(';')

          if (sMemoType[0] != 'rates') { break }
          result.source = sMemoType[1]
          for (var j = 0; j < sMemoData.length; j++) {
            result.rates.push(sMemoData[j])
          }
          
          results.meta.push(result)
        }
        log(results)
      },
      async oracleFeed() {
        // addresses are oracle-sam and xumm oracle
        const request = {
          'id': 'threexrp-oracle-data',
          'command': 'subscribe',
          'accounts': [process.env.XRPL_SOURCE_ACCOUNT]
        }               
        let response = await client.send(request)
      },
      listenEventLoop(interval = 30000) {
        const  self = this
        setInterval(function() {
          self.emit('oracle-fetch')
        }, interval)
      },
      startEventLoop() {
        const self = this
        this.addListener('oracle-fetch', async function() {
          let { data }  = await axios.get(feedUrl)
          const keys = Object.keys(data)
          for(let oracle of keys) {
            // log(oracle)
            self.processData(oracle)
          }
        })
      },
      async processData(oracle) {
        if (oracle == null) { return {} }

        let { data } = await axios.get(baseUrl + '/api/aggregator?oracle=' + oracle)
      },
      async fetchData() {
        return new Promise((resolve, reject) => {
          fs.readFile(path.join(__dirname + '/providers/sources.json'), async (err, data) => {
            if (err) throw err
            resolve(JSON.parse(data))
          })
        })
      },
      async createEndPoint(app, testing = false) {
        const self = this
        app.get('/api/feed/data', async function(req, res) {
            // allow cors through for local testing.
            if (testing) {
              res.header("Access-Control-Allow-Origin", "*")    
            }

            const data = await self.fetchData()
            res.json(data)
        })

        app.get('/api/aggregator', async function(req, res) {
            // allow cors through for local testing.
            if (testing) {
              res.header("Access-Control-Allow-Origin", "*")    
            }

            if (!('oracle' in req.query)) { return res.json({ 'error' : 'missing parameter oracle'}) }

            const data = await self.run(req.query.oracle)
            log('dataSubmission: ' + req.query.oracle)
            
            fifo.push(data)
            res.json(data)
        })
      },
      async LedgerFeeCalculation(debug = false) {
        const stats = await client.send({
            "id": 2,
            "command": "server_state"
        })
        const basefee = 10
        const load_factor = stats.state.load_factor * 1
        const load_base = stats.state.load_base * 1
        const current_fee = Math.round((basefee * load_factor) / load_base)
    
        if (debug) {
          log('stats', stats)
          log('fee-basefee', basefee)
          log('fee-load_factor', load_factor)
          log('fee-load_base', load_base)
          log('fee-calculation', current_fee)
        }
    
        // we can get a bit more fancy here and add some levels... for when if batch fails multiple times.
        // https://gist.github.com/WietseWind/3e9f9339f37a5881978a9661f49b0e52
    
        return current_fee
      },
      async processFifo(sequence) {
        log('PUBLISH DATA fifo length: ' + fifo.length)
        const fee = await this.LedgerFeeCalculation(false)
        let count = 0
        while(fifo.length > 0) {
          const publisher = new currency()
          const data = fifo.pop()

          if (process.env.PUBLISH_TO_XRPL) {
            publisher.publish(client, data, sequence, fee, count, this)  
          }

          sequence++
        }
        while(retry.length > 0) {
          fifo.unshift(retry.pop())
        }
      },
      retryPublish(data) {
        retry.push(data)
      }
    })
  }
}

const oracle = new Oracle()
oracle.createEndPoint(app, process.env.ALLOW_CORS)
oracle.start()
