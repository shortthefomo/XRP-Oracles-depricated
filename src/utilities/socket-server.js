'use strict'

const EventEmitter = require('events')
const WebSocketServer = require('ws').Server
const logger = require('../logger.js');

module.exports = class SocketServer extends EventEmitter {
  constructor() {
    super()

    Object.assign(this, {
      start(server, pubsub) {
        const wss = new WebSocketServer({ server: server })
        wss.on('connection', (ws, req) => {
          ws.on('message', (data) => {
            try {
              if (pubsub == null) { return }
              const json = JSON.parse(data, true)
              switch (json.request) {
                case 'PUBLISH':
                  pubsub.publish(ws, json.channel, json.message)
                  break
                case 'SUBSCRIBE':
                  logger.debug('SUBSCRIBE: ' + json.message)
                  pubsub.subscribe(ws, json.channel)
                  
                  // if (process.env.ALLOW_CORS) {
                  //   logger.debug('client subscribed to: ' + json.channel)
                  //   pubsub.subscribe(ws, json.channel)
                  // }
                  // else {
                  //   if (req.headers.origin != process.env.DOMAIN) {
                  //     logger.debug('header denied: ' + req.headers.origin + ' :' + json.message)
                  //     ws.send(JSON.stringify({ access: 'denied' }))
                  //     ws.close()
                  //   }
                  // }
                  break
              }
            } catch (error) {
              logger.error(error)
            }
          })
          ws.on('close', () => {
            logger.debug('Stopping client connection.')
          })
          ws.on('error', (error) => {
            logger.error('SocketServer error')
            logger.error(error)
          })
        })
      }
    })
  }
}