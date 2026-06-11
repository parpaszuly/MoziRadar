import http from 'node:http'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, extname, normalize, resolve } from 'node:path'
import { PORT, HOST } from './config.js'
import { logger } from './logger.js'
import { handleApi } from './routes/api.js'
import type { RouteContext } from './routes/types.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const WEB_DIR = resolve(process.cwd(), 'web')

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): boolean {
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  const candidate = urlPath === '/' || urlPath === ''
    ? join(WEB_DIR, 'index.html')
    : join(WEB_DIR, safePath)

  if (!candidate.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return true }

  const filePath = existsSync(candidate) && statSync(candidate).isDirectory()
    ? join(candidate, 'index.html')
    : candidate

  if (!existsSync(filePath)) return false

  try {
    const stat = statSync(filePath)
    const ext = extname(filePath)
    const etag = `"${stat.mtimeMs}-${stat.size}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return true
    }
    const data = readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
  return true
}

export function startServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const path = url.pathname
    const method = req.method || 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    try {
      const ctx: RouteContext = { req, res, path, method, url }
      if (await handleApi(ctx)) return
      if (serveStatic(req, res, path)) return
      res.writeHead(404); res.end('Not found')
    } catch (err) {
      logger.error({ err }, 'Server error')
      res.writeHead(500); res.end('Server error')
    }
  })

  server.listen(PORT, HOST, () => {
    logger.info({ port: PORT, host: HOST }, `MoziRadar: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  })

  return server
}
