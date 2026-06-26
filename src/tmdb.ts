import { TMDB_API_KEY } from './config.js'
import { getSetting } from './db.js'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500'

function tmdbApiKey(): string | null {
  return getSetting('tmdb_api_key') || TMDB_API_KEY || null
}

interface TmdbEnrichment {
  title: string | null
  poster_url: string | null
  overview: string | null
  year: number | null
  tmdb_id: number | null
}

export async function tmdbSearch(type: 'film' | 'series', title: string): Promise<TmdbEnrichment> {
  const apiKey = tmdbApiKey()
  if (!apiKey) return { title: null, poster_url: null, overview: null, year: null, tmdb_id: null }

  const endpoint = type === 'film' ? 'movie' : 'tv'
  const titleKey = type === 'film' ? 'title' : 'name'
  const origTitleKey = type === 'film' ? 'original_title' : 'original_name'
  const needle = title.trim().toLowerCase()

  function pickBestHit(results: Record<string, unknown>[]): Record<string, unknown> | null {
    if (!results.length) return null
    return results.reduce((best, hit) => {
      const isExact = ((hit[titleKey] as string) ?? '').trim().toLowerCase() === needle
        || ((hit[origTitleKey] as string) ?? '').trim().toLowerCase() === needle
      const bestExact = ((best[titleKey] as string) ?? '').trim().toLowerCase() === needle
        || ((best[origTitleKey] as string) ?? '').trim().toLowerCase() === needle
      const score = (isExact ? 1_000_000 : 0)
        + (typeof hit.vote_count === 'number' ? hit.vote_count : 0) * 10
        + (typeof hit.popularity === 'number' ? hit.popularity : 0)
      const bestScore = (bestExact ? 1_000_000 : 0)
        + (typeof best.vote_count === 'number' ? best.vote_count : 0) * 10
        + (typeof best.popularity === 'number' ? best.popularity : 0)
      return score > bestScore ? hit : best
    }, results[0])
  }

  async function query(lang: string): Promise<TmdbEnrichment | null> {
    try {
      const url = `${TMDB_BASE}/search/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=${lang}&page=1`
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!resp.ok) return null
      const data = await resp.json() as { results?: Record<string, unknown>[] }
      const hit = pickBestHit(data.results ?? [])
      if (!hit) return null

      const posterPath = hit.poster_path as string | undefined
      const rawOverview = hit.overview as string | undefined
      const relDate = (type === 'film' ? hit.release_date : hit.first_air_date) as string | undefined
      const year = relDate ? parseInt(relDate.slice(0, 4), 10) || null : null
      const tmdb_id = typeof hit.id === 'number' ? hit.id : null

      return {
        title: (hit[titleKey] as string | undefined) || null,
        poster_url: posterPath ? `${TMDB_IMG}${posterPath}` : null,
        overview: rawOverview?.trim() || null,
        year,
        tmdb_id,
      }
    } catch {
      return null
    }
  }

  const hu = await query('hu-HU')
  if (hu) {
    if (!hu.overview) {
      const en = await query('en-US')
      if (en?.overview) hu.overview = en.overview
    }
    return hu
  }
  return (await query('en-US')) ?? { title: null, poster_url: null, overview: null, year: null, tmdb_id: null }
}

export async function tmdbFetchCast(type: 'film' | 'series', tmdbId: number): Promise<Array<{name: string; character: string}>> {
  const apiKey = tmdbApiKey()
  if (!apiKey) return []
  const endpoint = type === 'film' ? 'movie' : 'tv'
  try {
    const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/credits?api_key=${apiKey}&language=hu-HU`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return []
    const data = await resp.json() as { cast?: Array<{name?: string; character?: string}> }
    return (data.cast ?? [])
      .slice(0, 8)
      .filter(c => c.name)
      .map(c => ({ name: c.name!, character: c.character ?? '' }))
  } catch {
    return []
  }
}

export async function tmdbFetchDetails(type: 'film' | 'series', tmdbId: number): Promise<{runtime: number | null; genres: string[]; seasons_count: number | null}> {
  const apiKey = tmdbApiKey()
  if (!apiKey) return { runtime: null, genres: [], seasons_count: null }
  const endpoint = type === 'film' ? 'movie' : 'tv'
  try {
    const url = `${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${apiKey}&language=hu-HU`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return { runtime: null, genres: [], seasons_count: null }
    const data = await resp.json() as {
      runtime?: number
      episode_run_time?: number[]
      genres?: Array<{name: string}>
      number_of_seasons?: number
    }
    const runtime = type === 'film'
      ? (data.runtime ?? null)
      : (data.episode_run_time?.[0] ?? null)
    const genres = (data.genres ?? []).map(g => g.name).filter(Boolean)
    const seasons_count = type === 'series' ? (typeof data.number_of_seasons === 'number' ? data.number_of_seasons : null) : null
    return { runtime, genres, seasons_count }
  } catch {
    return { runtime: null, genres: [], seasons_count: null }
  }
}

export async function tmdbFetchSimilar(type: 'film' | 'series', tmdbId: number): Promise<Array<{title: string; year: number | null; poster_url: string | null; tmdb_id: number; type: string}>> {
  const apiKey = tmdbApiKey()
  if (!apiKey) return []
  const endpoint = type === 'film' ? 'movie' : 'tv'
  const titleKey = type === 'film' ? 'title' : 'name'
  const dateKey = type === 'film' ? 'release_date' : 'first_air_date'
  try {
    const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/similar?api_key=${apiKey}&language=hu-HU&page=1`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return []
    const data = await resp.json() as { results?: Array<Record<string, unknown>> }
    return (data.results ?? []).slice(0, 8).map(r => ({
      title: String(r[titleKey] ?? ''),
      year: r[dateKey] ? parseInt(String(r[dateKey]).slice(0, 4), 10) || null : null,
      poster_url: r.poster_path ? `${TMDB_IMG}${r.poster_path}` : null,
      tmdb_id: typeof r.id === 'number' ? r.id : 0,
      type,
    })).filter(r => r.title && r.tmdb_id)
  } catch {
    return []
  }
}

export async function tmdbFetchProviders(type: 'film' | 'series', tmdbId: number, country = 'HU'): Promise<Array<{name: string; logo_url: string; type: string}>> {
  const apiKey = tmdbApiKey()
  if (!apiKey) return []
  const endpoint = type === 'film' ? 'movie' : 'tv'
  const TMDB_LOGO = 'https://image.tmdb.org/t/p/original'
  try {
    const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/watch/providers?api_key=${apiKey}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return []
    const data = await resp.json() as { results?: Record<string, { flatrate?: Array<{provider_name: string; logo_path: string}>; rent?: Array<{provider_name: string; logo_path: string}>; buy?: Array<{provider_name: string; logo_path: string}> }> }
    const countryData = data.results?.[country]
    if (!countryData) return []
    const out: Array<{name: string; logo_url: string; type: string}> = []
    for (const p of (countryData.flatrate ?? [])) {
      if (p.provider_name && p.logo_path) out.push({ name: p.provider_name, logo_url: `${TMDB_LOGO}${p.logo_path}`, type: 'flatrate' })
    }
    for (const p of (countryData.rent ?? [])) {
      if (p.provider_name && p.logo_path && !out.find(o => o.name === p.provider_name)) out.push({ name: p.provider_name, logo_url: `${TMDB_LOGO}${p.logo_path}`, type: 'rent' })
    }
    return out.slice(0, 8)
  } catch {
    return []
  }
}

export async function runBackfill(listItems: () => import('./db.js').MediaItem[], updateEnrichment: (id: number, data: Parameters<typeof import('./db.js').updateMediaItemEnrichment>[1]) => boolean): Promise<number> {
  const items = listItems()
  let updated = 0
  for (const item of items) {
    try {
      const enrichment = await tmdbSearch(item.type, item.title)
      if (!enrichment.tmdb_id) continue
      const [cast, details] = await Promise.all([
        tmdbFetchCast(item.type, enrichment.tmdb_id),
        tmdbFetchDetails(item.type, enrichment.tmdb_id),
      ])
      updateEnrichment(item.id, {
        tmdb_id: enrichment.tmdb_id,
        poster_url: enrichment.poster_url ?? undefined,
        overview: enrichment.overview ?? undefined,
        year: enrichment.year ?? undefined,
        cast: cast.length ? JSON.stringify(cast) : null,
        genres: details.genres.length ? JSON.stringify(details.genres) : null,
        runtime: details.runtime ?? null,
        seasons_count: details.seasons_count ?? null,
      })
      updated++
    } catch { /* tolerated */ }
  }
  return updated
}
