const isProduction = process.env.NODE_ENV === 'production'

function formatMsg(level: string, data: Record<string, unknown>, msg: string): string {
  const ts = new Date().toISOString()
  const extra = Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
  return `${ts} [${level}] ${msg}${extra ? ' ' + extra : ''}`
}

export const logger = {
  info:  (data: Record<string, unknown> | string, msg?: string) => {
    const [d, m] = typeof data === 'string' ? [{}, data] : [data, msg ?? '']
    console.log(formatMsg('INFO', d, m))
  },
  error: (data: Record<string, unknown> | string, msg?: string) => {
    const [d, m] = typeof data === 'string' ? [{}, data] : [data, msg ?? '']
    console.error(formatMsg('ERROR', d, m))
  },
  warn:  (data: Record<string, unknown> | string, msg?: string) => {
    const [d, m] = typeof data === 'string' ? [{}, data] : [data, msg ?? '']
    console.warn(formatMsg('WARN', d, m))
  },
}
