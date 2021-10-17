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
const PubSubManager = require('./utilities/pubsub-v2.js')
const SocketServer = require('./utilities/socket-server.js')

const log = debug('oracle:main')

class Oracle extends EventEmitter {
  constructor(Config) {
    super()
    dotenv.config()

    let fifo = []
    let retry = []
    const client = new XrplClient(process.env.ENDPOINT)
    const pubsub = new PubSubManager()
    const socket = new SocketServer()
    let oracleData = []

    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(oracle).run())
        })
      },
      async start() {
        pubsub.start()
        socket.start(server, pubsub)
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
      listenEventLoop(interval = 20000) {
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
            // log(oracle)
            self.processData(oracle)
          }
        })
      },
      async processData(oracle) {
        if (oracle == null) { return {} }

        let { data } = await axios.get('http://localhost:5000/api/aggregator?oracle=' + oracle)
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
      async publish(sequence) {

        log('PUBLISH DATA')
        log('fifo length: ' + fifo.length)

        while(fifo.length > 0) {
          const publisher = new currency()
          const data = fifo.pop()
          this.sendSocket(data)
          const result = publisher.publish(client, data, sequence, this)
          sequence++
        }
        fifo = retry
        retry = []
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


server.on('request', app)
server.listen(5000, () => {
   log('Server listening on http://localhost:5000')
})