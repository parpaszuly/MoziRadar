import type http from 'node:http'

const clients = new Set<http.ServerResponse>()

export function addSseClient(res: http.ServerResponse): void {
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

export function broadcastEvent(type: string): void {
  if (!clients.size) return
  const payload = `data: ${JSON.stringify({ type })}\n\n`
  for (const client of [...clients]) {
    try {
      client.write(payload)
    } catch {
      clients.delete(client)
    }
  }
}
