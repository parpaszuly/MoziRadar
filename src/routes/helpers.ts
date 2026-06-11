import type http from 'node:http'

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function parseBody<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
  try { return JSON.parse((await readBody(req)).toString()) as T }
  catch { json(res, { error: 'Érvénytelen JSON' }, 400); return null }
}
