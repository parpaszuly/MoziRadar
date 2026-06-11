import { startServer } from './server.js'
import { logger } from './logger.js'

const server = startServer()

process.on('SIGTERM', () => {
  logger.info('Shutting down...')
  server.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  logger.info('Shutting down...')
  server.close(() => process.exit(0))
})
