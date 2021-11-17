'use strict'

const EventEmitter = require('events')
const debug = require( 'debug')
const WebSocketServer = require('ws').Server

const log = debug('oracle:socketserver')

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
                  log('SUBSCRIBE: ' + json.message)
                  if (process.env.ALLOW_CORS) {
                    log('client subscribed to: ' + json.channel)
                    pubsub.subscribe(ws, json.channel)
                  }
                  else {
                    if (req.headers.origin != process.env.DOMAIN) {
                      log('header denied: ' + req.headers.origin + ' :' + json.message)
                      ws.send(JSON.stringify({ access: 'denied' }))
                      ws.close()
                    }
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