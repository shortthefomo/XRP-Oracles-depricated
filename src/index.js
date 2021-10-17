'use strict'

const { XrplClient } = require('xrpl-client')
const app = require('express')()
const express = require('express')
const path = require( 'path')
const server = require('http').createServer()
const fs = require( 'fs')
const debug = require( 'debug')
const aggregator = require('xrp-price-aggregator')
const stats = require('stats-analysis')
const currency = require('./publishers/currency.js') 
const dotenv = require('dotenv')
const axios = require('axios')
const EventEmitter = require('events')
const WebSocketServer = require('ws').Server
const PubSubManager = require('./utilities/pubsub-v2.js')

const log = debug('oracle:main')

class Oracle extends EventEmitter {
  constructor(Config) {
    super()
    dotenv.config()

    const fifo = []
    const client = new XrplClient(process.env.ENDPOINT)
    const pubsub = new PubSubManager()
    let data = null
    let oracleData = []

    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(oracle).run())
        })
      },
      async start() {
        this.startEventLoop()
        this.listenEventLoop()
        await client
        client.on('ledger', async (event) =>  {
          if (event.type == 'ledgerClosed') {
            const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
            this.publish(account_data.Sequence)
          }
        })
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
          let { data }  = await axios.get('http://localhost:5000/api/feed/data')
          const keys = Object.keys(data)
          for(let oracle of keys) {
            log(oracle)
            self.processData(oracle)
          }
        })
      },
      async processData(oracle) {
        if (oracle == null) { return {} }
        let prev = 0
        if (oracle in oracleData) {
          prev = oracleData[oracle].filteredMedian
        }

        let { data } = await axios.get('http://localhost:5000/api/aggregator?oracle=' + oracle)
        data.color_bg = 'bg-purple'

        if (prev != 0) {
            if (prev > data.filteredMedian) {
                data.color_bg = 'bg-pink'
            }
            else {
                data.color_bg = 'bg-green'
            }
        }
        if (data.type == 'currency') {
          //push data to the currency websocket
        }
        else {
          //push data to the alts websocket
        }
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
            if (data.type == 'alt' || data.type == 'currency') {
              fifo.push(data)
              pubsub.route(data, data.type)
            }
            res.json(data)
        })
      },
      publish(sequence) {

        log('PUBLISH DATA')
        log('fifo length: ' + fifo.length)
        while(fifo.length > 0) {
          const publisher = new currency()
          const result = publisher.publish(client, fifo.pop(), sequence, fifo)
          sequence++
        }
      },
      socketServer() {
        const wss = new WebSocketServer({ server: server })
        wss.on('connection', (ws, req) => {
          ws.on('message', (data) => {
            try {
              if (pubsub == null) { return }
              if (data.charAt(0) != '{') { return } 
              const json = JSON.parse(data, true)

              switch (json.request) {
                case 'PUBLISH':
                  pubsub.publish(ws, json.channel, json.message)
                  break
                case 'SUBSCRIBE':
                  let accessCheck = false
                  
                  if (corsStatic.includes(json.message)) {
                    accessCheck = true
                  }
                  else {
                    if (process.env.ALLOW_CORS == 'localhost') {
                      accessCheck = true
                    }
                    else {
                      if (req.headers.origin != process.env.DOMAIN) {
                        log('header denied: ' + req.headers.origin + ' :' + json.message)
                        ws.send(JSON.stringify({ access: 'denied' }))
                        ws.close()
                      }
                      else {
                        accessCheck = true
                      } 
                    }
                  }
                  if (accessCheck) {
                    pubsub.subscribe(ws, json.channel)  
                  }
                  break
              }
            } catch (error) {
              log(error)
            }

          })
          ws.on('close', () => {
            log('Stopping client connection.')
          })
          ws.on('error', (error) => {
            log('SocketServer error')
            log(error)
          })
        })
      }
    })
  }
}

const oracle = new Oracle()
oracle.createEndPoint(app, process.env.ALLOW_CORS)
oracle.start()


server.on('request', app)
server.listen(5000, () => {
   log('Server listening on http://localhost:5000')
})