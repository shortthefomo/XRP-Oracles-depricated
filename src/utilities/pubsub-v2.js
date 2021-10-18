'use strict'

const EventEmitter = require('events')
const debug = require( 'debug')
const log = debug('oracle:pubsub')

module.exports = class PubSubManager extends EventEmitter {
  constructor() {
    super()

    const self = this

    const channels = {
      currency: {
        message: [],
        subscribers: []
      },
      alt: {
        message: [],
        subscribers: []
      },
    }

    Object.assign(this, {
      subscribe(subscriber, channel) {
        try {
          channels[channel].subscribers.push(subscriber)
        } catch (error) {
          log('error', 'trying to join channel: ' + channel)
        }
      },
      removeBroker() {
        //clearInterval(this.brokerId);
      },
      publish(channel, message) {
        try {
          channels[channel].message.push(message)
        } catch (error) {
          log(error)
        }
      },
      broker() {
        for (const channel in channels) {
          if (channels.hasOwnProperty(channel)) {
            const channelObj = channels[channel]
            if (channels[channel].subscribers.length > 0) {
              if (channelObj.message) {
                channelObj.subscribers.forEach(subscriber => {

                  for (var i = 0; i < channelObj.message.length; i++) {
                    const string =  JSON.stringify(channelObj.message[i])
                    subscriber.send('{"' + channel +'": ' + string + '}')
                    //log('{"' + channel +'": ' + string + '}')
                  }
                })

                channelObj.message = []
              }   
            }
          }
        }
      },
      route(message, channel) {
        this.publish(channel, message)
      },
      setup() {
        // Listen for our event and dispatch its process
        this.addListener('broker', function() {
          this.broker()
        })
      },
      start() {
        this.setup()
        // This thing needs to burn a hole in the sun.
        setInterval(() => {
          self.emit('broker', true)
        }, 10)
      }
    })
  }
}