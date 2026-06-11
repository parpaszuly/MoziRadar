import { AI_PROVIDER, AI_API_KEY, AI_BASE_URL } from './config.js'
import { getSetting } from './db.js'

interface LlmRec {
  type: 'film' | 'series'
  title: string
  year: number | null
  reason: string
}

function getAiConfig(): { provider: string; apiKey: string; baseUrl: string } {
  const provider = getSetting('ai_provider') || AI_PROVIDER
  const apiKey = getSetting('ai_api_key') || AI_API_KEY
  const baseUrl = getSetting('ai_base_url') || AI_BASE_URL
  return { provider, apiKey, baseUrl }
}

async function callOpenAICompat(baseUrl: string, apiKey: string, model: string, prompt: string, timeoutMs: number): Promise<LlmRec[]> {
  const url = `${baseUrl}/chat/completions`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) throw new Error(`AI API error: ${resp.status}`)
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content ?? ''
  return parseJsonRecs(text)
}

async function callClaude(apiKey: string, model: string, prompt: string, timeoutMs: number): Promise<LlmRec[]> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`)
  const data = await resp.json() as { content?: Array<{ text?: string }> }
  const text = data.content?.[0]?.text ?? ''
  return parseJsonRecs(text)
}

function parseJsonRecs(text: string): LlmRec[] {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  const arr: unknown = JSON.parse(cleaned)
  if (!Array.isArray(arr)) return []
  return arr.filter(
    (r): r is LlmRec =>
      r && ['film', 'series'].includes((r as LlmRec).type) &&
      typeof (r as LlmRec).title === 'string' && (r as LlmRec).title.trim().length > 0
  ).map(r => ({
    type: (r as LlmRec).type,
    title: (r as LlmRec).title.trim(),
    year: typeof (r as LlmRec).year === 'number' ? (r as LlmRec).year : null,
    reason: typeof (r as LlmRec).reason === 'string' ? (r as LlmRec).reason.trim() : '',
  }))
}

export async function generateRecommendations(prompt: string, timeoutMs = 60_000): Promise<LlmRec[]> {
  const { provider, apiKey, baseUrl } = getAiConfig()
  if (!apiKey) throw new Error('AI API key not configured')

  switch (provider) {
    case 'claude':
      return callClaude(apiKey, 'claude-haiku-4-5-20251001', prompt, timeoutMs)

    case 'deepseek': {
      const url = baseUrl || 'https://api.deepseek.com/v1'
      return callOpenAICompat(url, apiKey, 'deepseek-chat', prompt, timeoutMs)
    }

    case 'gemini': {
      const url = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
      return callOpenAICompat(url, apiKey, 'gemini-2.0-flash-lite', prompt, timeoutMs)
    }

    case 'openai':
    default: {
      const url = baseUrl || 'https://api.openai.com/v1'
      return callOpenAICompat(url, apiKey, 'gpt-4o-mini', prompt, timeoutMs)
    }
  }
}
