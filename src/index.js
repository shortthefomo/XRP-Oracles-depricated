'use strict'

const app = require('express')()
const express = require('express')
const path = require( 'path')
const server = require('http').createServer()
const fs = require( 'fs')
const debug = require( 'debug')
const aggregator = require('xrp-price-aggregator')
const stats = require('stats-analysis')
const currency = require('./publishers/currency.js') 

const log = debug('oracle:main')

class Oracle {
  constructor() {
    let data = null
    Object.assign(this, {
      async run(oracle) {
        return new Promise((resolve, reject) => {
          resolve(new aggregator(oracle).run())
        })
        
      },
      async fetchData() {
        log('fetchData')
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
            log(data)
            if (data.type == 'alt' || data.type == 'currency') {
              self.publish(data)
            }
            res.json(data)
        })
      },
      publish(data) {
        const publisher = new currency()
        publisher.publish(data)
      }
    })
  }
}

const oracle = new Oracle()
oracle.createEndPoint(app, true)
//oracle.run()


server.on('request', app)
server.listen(5000, () => {
   log('Server listening on http://localhost:5000')
})