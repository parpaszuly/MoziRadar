import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Load .env if present (simple parser, no dependency needed)
const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = val
  }
}

export const PORT = parseInt(process.env.PORT ?? '3421', 10)
export const HOST = process.env.HOST ?? '0.0.0.0'
export const DB_PATH = process.env.DB_PATH ?? './store/moziradar.db'
export const TMDB_API_KEY = process.env.TMDB_API_KEY ?? ''
export const AI_PROVIDER = (process.env.AI_PROVIDER ?? 'claude') as 'claude' | 'openai' | 'deepseek' | 'gemini'
export const AI_API_KEY = process.env.AI_API_KEY ?? ''
export const AI_BASE_URL = process.env.AI_BASE_URL ?? ''
