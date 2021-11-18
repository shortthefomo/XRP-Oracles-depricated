'use strict'

const { XrplClient } = require('xrpl-client')
const { XummSdk } = require('xumm-sdk')
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
const PubSubManager = require('./utilities/pubsub-v2.js')
const SocketServer = require('./utilities/socket-server.js')

const log = debug('oracle:main')
const userlog = debug('oracle:user')

dotenv.config()

let server = null
if (process.env.CERT != null) {
  log('using https: for webhead: ' + process.env.SSLPORT)
  const sslOptions = {
      cert: fs.readFileSync(__dirname + process.env.CERT, 'utf8'),
      key: fs.readFileSync(__dirname + process.env.KEY, 'utf8')
  }
  httpsServer = https.createServer(sslOptions, app).listen(process.env.SSLPORT)   
}

log('using http: for webhead: ' + (process.env.PORT))
httpServer = http.createServer(app).listen(process.env.PORT)

class Oracle extends EventEmitter {
  constructor(Config) {
    super()

    let fifo = []
    let retry = []
    const baseUrl = process.env.BASEURL
    const feedUrl = baseUrl + '/api/feed/data'
    const client = new XrplClient(process.env.ENDPOINT)
    const Sdk = new XummSdk(process.env.XUMM_APIKEY, process.env.XUMM_APISECRET)
    const pubsub = new PubSubManager()
    const httpsSocket = new SocketServer()
    const httpSocket = new SocketServer()
    let oracleData = []

    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(feedUrl, oracle).run())
        })
      },
      async start() {
        pubsub.start()
        httpsSocket.start(httpsServer, pubsub)
        httpSocket.start(httpServer, pubsub)
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
        if (pubsub != null) {
          pubsub.route(results, 'oracles')
        }
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

        app.get('/api/v2/xumm-sign-in', async function(req, res) {
          // allow cors through for local testing.
          if (testing) {
              // log('allow cors through for local testing')
              res.header("Access-Control-Allow-Origin", "*")    
          }

          const data = await self.userSignIn()
          res.json(data)
      })
      },
      sendSocket(data) {
        const oracle = data.symbol
        if (oracle in oracleData) {
          data.previous = oracleData[oracle].previous
        }

        log('pubsub: ' + data.symbol + ':' + data.type)
        pubsub.route(data, 'currency')

        if (!(oracle in oracleData)) {
          oracleData[oracle] = {
            previous : 0
          }
        }
        oracleData[oracle].previous = data.filteredMedian
      },
      async processFifo(sequence) {

        log('PUBLISH DATA fifo length: ' + fifo.length)

        while(fifo.length > 0) {
          const publisher = new currency()
          const data = fifo.pop()

          if (process.env.PUBLISH_TO_XRPL) {
            publisher.publish(client, data, sequence, this)  
          }

          // socket shorld not get retry data
          if (!('maxRetry' in data)) {
            this.sendSocket(data)  
          }
          sequence++
        }
        while(retry.length > 0) {
          fifo.unshift(retry.pop())
        }
      },
      retryPublish(data) {
        retry.push(data)
      },
      async userSignIn() {
				const SignInPayload = {
					txjson: {
						TransactionType : 'SignIn'
					}
				}
				//log(SignInPayload)

				const payload = await Sdk.payload.createAndSubscribe(SignInPayload, event => {
					if (event.data.signed === true) {
						return event.data
					}

					if (event.data.signed === false) {
						return false
					}
				})
        userlog(payload)
				this.subscriptionListener(payload)
				

				return payload
			},

			async subscriptionListener(subscription) {
				const self = this
				const resolveData = await subscription.resolved

				if (resolveData.signed === false) { return }

				if (resolveData.signed === true) {
					userlog('Woohoo! The sign request was signed :)')

					/**
					 * Let's fetch the full payload end result, and get the issued
					 * user token, we can use to send our next payload per Push notification
					 */
					const result = await Sdk.payload.get(resolveData.payload_uuidv4)
					
          userlog(result)
					// guard clause to make sure we only looking at sign in here
					if (result.payload.tx_type != 'SignIn') { return }
          userlog('User token:', result.application.issued_user_token)
					
					

					if (pubsub != null) {
						const info = {
							'uuid': result.meta.uuid,
							'tx_type': result.payload.tx_type,
							'created_at': result.payload.created_at,
							'account': result.response.account
						}
            pubsub.route(info, 'users')
          }
				}
			},
    })
  }
}

const oracle = new Oracle()
oracle.createEndPoint(app, process.env.ALLOW_CORS)
oracle.start()


// //server.on('request', app)
// httpServer.listen(process.env.PORT, () => {
//    log('Server listening: ' + process.env.PORT)
// })