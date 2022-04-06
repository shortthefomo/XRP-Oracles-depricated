'use strict'

const { XrplClient } = require('xrpl-client')
const { XummSdk } = require('xumm-sdk')
const app = require('express')()
const express = require('express')
const path = require( 'path')
const https = require('https')
const http = require('http')
const fs = require( 'fs')
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const aggregator = require('xrp-price-aggregator')
const stats = require('stats-analysis')
const currency = require('./publishers/currency.js') 
const dotenv = require('dotenv')
const axios = require('axios')
const EventEmitter = require('events')
const PubSubManager = require('./utilities/pubsub-v2.js')
const SocketServer = require('./utilities/socket-server.js')
// const rootCas = require('ssl-root-cas').create()

// rootCas.addFile(path.resolve(__dirname, process.env.CERT))
// rootCas.addFile(path.resolve(__dirname, process.env.KEY))

require('https').globalAgent.options.ca = require('ssl-root-cas').create()

dotenv.config()

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL == null ? 'warn' : process.env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: 'app-%DATE%.log',
      dirname: 'logs',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    }),
  ],
})
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }))
}

let httpsServer = null
if (process.env.CERT != null) {
  logger.info('using https: for webhead: ' + process.env.SSLPORT)
  const sslOptions = {
      cert: fs.readFileSync(__dirname + process.env.CERT, 'utf8'),
      key: fs.readFileSync(__dirname + process.env.KEY, 'utf8'),
      ca: [
        fs.readFileSync(__dirname + process.env.BUNDLE, 'utf8')
      ]
  }
  httpsServer = https.createServer(sslOptions, app).listen(process.env.SSLPORT)   
}

axios.defaults.timeout = process.env.TIMEOUT_SECONDS != null ? process.env.TIMEOUT_SECONDS * 1000 : 15000;
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

logger.info('using http: for webhead: ' + (process.env.PORT))
const httpServer = http.createServer(app).listen(process.env.PORT)

class Oracle extends EventEmitter {
  constructor(Config) {
    super()

    let fifo = []
    let retry = []
    const baseUrl = process.env.BASEURL
    const feedUrl = baseUrl + '/api/feed/data'
    const client = new XrplClient(process.env.ENDPOINT)
    logger.info(`using XummSdk, env.XUMM_APIKEY defined: ${process.env.XUMM_APIKEY != null}`)
    const Sdk = process.env.XUMM_APIKEY == null ? null : new XummSdk(process.env.XUMM_APIKEY, process.env.XUMM_APISECRET)
    const password = process.env.PASSWORD
    const providerConfig = process.env.PROVIDER_CONFIG == null ? 'sources.json' : process.env.PROVIDER_CONFIG
    const pubsub = new PubSubManager()
    const httpsSocket = new SocketServer()
    const httpSocket = new SocketServer()
    let oracleData = []
    let runningSince = new Date()
    let sourceBalanceDrops = null

    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(feedUrl, oracle).run())
        })
      },
      async start() {
        pubsub.start()
        if(httpsServer != null) {
          httpsSocket.start(httpsServer, pubsub)
        }
        httpSocket.start(httpServer, pubsub)
        this.oracleFeed()
        this.startEventLoop()
        this.listenEventLoop()
        await client

        client.on('ledger', async (event) =>  {
          if (event.type == 'ledgerClosed') {
            const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
            //logger.debug(account_data)
            if (account_data != null && 'Sequence' in account_data) {
              sourceBalanceDrops = account_data.Balance
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
        logger.debug(results)
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
          try {
            let { data }  = await axios.get(feedUrl)
            const keys = Object.keys(data)
            for(let oracle of keys) {
              // logger.verbose(oracle)
              self.processData(oracle)
            }
          } catch(e) {
            if(e.code == 'ETIMEDOUT') {
              logger.warn(`Timeout calling ${feedUrl}`)
            } else {
              throw e;
            }
          }
        })
      },
      async processData(oracle) {
        if (oracle == null) { return {} }

        let { data } = await axios.get(baseUrl + '/api/aggregator?oracle=' + oracle)
      },
      async fetchData() {
        return new Promise((resolve, reject) => {
          fs.readFile(path.join(__dirname + '/providers/' + providerConfig), async (err, data) => {
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
            logger.verbose('dataSubmission: ' + req.query.oracle)
            
            fifo.push(data)
            res.json(data)
        })

        app.get('/api/v2/xumm-sign-in', async function(req, res) {
          // allow cors through for local testing.
          if (testing) {
              // logger.debug('allow cors through for local testing')
              res.header("Access-Control-Allow-Origin", "*")    
          }

          const data = await self.userSignIn()
          res.json(data)
      })

        app.get('/api/heartbeat', async function(req, res) {
          // allow cors through for local testing.
          if (testing) {
            res.header("Access-Control-Allow-Origin", "*")    
          }
          let data = { running: true }
          if (password != null && req.query.pwr === password) {
            data = { running: true, runningSince: runningSince, sourceBalanceDrops: sourceBalanceDrops }
          }
          res.json(data)
        })
      },
      sendSocket(data) {
        const oracle = data.symbol
        if (oracle in oracleData) {
          data.previous = oracleData[oracle].previous
        }

        logger.debug('pubsub: ' + data.symbol + ':' + data.type)
        pubsub.route(data, 'currency')

        if (!(oracle in oracleData)) {
          oracleData[oracle] = {
            previous : 0
          }
        }
        oracleData[oracle].previous = data.filteredMedian
      },
      async processFifo(sequence) {

        logger.debug('PUBLISH DATA fifo length: ' + fifo.length)

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
				if(Sdk == null) {
					this.subscriptionListener(false)
					return false
				}
				const SignInPayload = {
					txjson: {
						TransactionType : 'SignIn'
					}
				}
				//logger.debug(SignInPayload)

				const payload = await Sdk.payload.createAndSubscribe(SignInPayload, event => {
					if (event.data.signed === true) {
						return event.data
					}

					if (event.data.signed === false) {
						return false
					}
				})
        logger.debug(payload)
				this.subscriptionListener(payload)
				

				return payload
			},

			async subscriptionListener(subscription) {
				if(Sdk == null) { return }
				const self = this
				const resolveData = await subscription.resolved

				if (resolveData.signed === false) { return }

				if (resolveData.signed === true) {
					logger.debug('Woohoo! The sign request was signed :)')

					/**
					 * Let's fetch the full payload end result, and get the issued
					 * user token, we can use to send our next payload per Push notification
					 */
					const result = await Sdk.payload.get(resolveData.payload_uuidv4)
					
          logger.debug(result)
					// guard clause to make sure we only looking at sign in here
					if (result.payload.tx_type != 'SignIn') { return }
          logger.debug('User token:', result.application.issued_user_token)
					
					

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
//    logger.debug('Server listening: ' + process.env.PORT)
// })