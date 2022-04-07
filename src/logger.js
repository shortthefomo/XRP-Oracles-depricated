'use strict'

const dotenv = require('dotenv')
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

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

module.exports = logger;