import {
  listMediaUsers, getMediaUserById, getAllMediaUserStatuses,
  upsertMediaUserStatus, getMediaItem, listMediaCatalog, deleteMediaItem,
  getInternalRecommendations, getExternalRecsForUser,
  getGroupRecommendations, getExternalRecsForGroup, getGroupWatchlistItems,
  createMediaUser, updateMediaUser,
  createMediaItem, updateMediaItem, updateMediaItemEnrichment,
  listMediaRecommendations, replaceMediaRecommendations,
  getMediaRecommendationById, findMediaItemByTitleYear,
  getUserSeenProfile, getUserExcludedTitles, getUserStats,
  listItemsNeedingEnrichment,
  findMediaItemByTmdbId,
  getAllSettings, getSetting, setSetting,
  hasAnyUsers,
  MEDIA_USER_VALID_STATES,
  type RecRow, type WatchlistRow, type MediaItem,
} from '../db.js'
import { tmdbSearch, tmdbFetchCast, tmdbFetchDetails, runBackfill } from '../tmdb.js'
import { generateRecommendations } from '../ai.js'
import { json, parseBody } from './helpers.js'
import type { RouteContext } from './types.js'
import type http from 'node:http'

function requireAdmin(res: http.ServerResponse, val: unknown): boolean {
  const id = typeof val === 'number' ? val : parseInt(String(val ?? ''), 10)
  if (isNaN(id) || !getMediaUserById(id)?.is_admin) {
    json(res, { error: 'Csak admin' }, 403)
    return false
  }
  return true
}

interface RecommendedItem {
  id: number; type: string; title: string; year: number | null
  poster_url: string | null; overview: string | null; tmdb_id: number | null
  runtime: number | null; genres: string | null; cast: string | null
  likedBy: { name: string; userId: number; score: number }[]
}

function flattenJsonStringArray(raw: string | null, nameKey?: string): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const items = nameKey
      ? (parsed as Record<string, unknown>[]).slice(0, 8).map(o => String(o[nameKey] ?? '')).filter(Boolean)
      : (parsed as unknown[]).map(String).filter(Boolean)
    return items.length ? items.join(', ') : null
  } catch {
    return null
  }
}

function aggregateRecRows(rows: RecRow[]): RecommendedItem[] {
  const map = new Map<number, RecommendedItem>()
  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id, type: row.type, title: row.title, year: row.year,
        poster_url: row.poster_url, overview: row.overview,
        tmdb_id: row.tmdb_id, runtime: row.runtime,
        genres: flattenJsonStringArray(row.genres),
        cast: flattenJsonStringArray(row.cast, 'name'),
        likedBy: [],
      })
    }
    map.get(row.id)!.likedBy.push({ name: row.liker_name, userId: row.liker_user_id, score: row.liker_score })
  }
  return [...map.values()].sort((a, b) => {
    const aMax = Math.max(...a.likedBy.map(l => l.score))
    const bMax = Math.max(...b.likedBy.map(l => l.score))
    if (bMax !== aMax) return bMax - aMax
    return b.likedBy.length - a.likedBy.length
  })
}

interface WatchlistItem {
  id: number; type: string; title: string; year: number | null
  poster_url: string | null; overview: string | null; tmdb_id: number | null
  runtime: number | null; genres: string | null; cast: string | null
  source: 'watchlist'; reason: string
  plannedBy: { name: string; userId: number }[]
}

function aggregateWatchlistRows(rows: WatchlistRow[]): WatchlistItem[] {
  const map = new Map<number, WatchlistItem>()
  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id, type: row.type, title: row.title, year: row.year,
        poster_url: row.poster_url, overview: row.overview,
        tmdb_id: row.tmdb_id, runtime: row.runtime,
        genres: flattenJsonStringArray(row.genres),
        cast: flattenJsonStringArray(row.cast, 'name'),
        source: 'watchlist', reason: '',
        plannedBy: [],
      })
    }
    map.get(row.id)!.plannedBy.push({ name: row.watcher_name, userId: row.watcher_user_id })
  }
  for (const item of map.values()) {
    item.reason = item.plannedBy.map(p => `${p.name} tervezi`).join(', ')
  }
  return [...map.values()]
}

export async function handleApi(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx
  if (!path.startsWith('/api/')) return false

  try {

    // ---- Setup wizard ----

    if (path === '/api/setup/status' && method === 'GET') {
      json(ctx.res, { needsSetup: !hasAnyUsers() })
      return true
    }

    if (path === '/api/setup' && method === 'POST') {
      if (hasAnyUsers()) { json(ctx.res, { error: 'Már be van állítva' }, 400); return true }
      const body = await parseBody<{ name?: unknown; color?: unknown; tmdbKey?: unknown; aiProvider?: unknown; aiKey?: unknown; aiBaseUrl?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (typeof body.name !== 'string' || !body.name.trim()) {
        json(ctx.res, { error: 'name kötelező' }, 400); return true
      }
      const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#3B82F6'
      const admin = createMediaUser(body.name.trim(), color, null, true)
      if (body.tmdbKey && typeof body.tmdbKey === 'string') setSetting('tmdb_api_key', body.tmdbKey.trim())
      if (body.aiProvider && typeof body.aiProvider === 'string') setSetting('ai_provider', body.aiProvider.trim())
      if (body.aiKey && typeof body.aiKey === 'string') setSetting('ai_api_key', body.aiKey.trim())
      if (body.aiBaseUrl && typeof body.aiBaseUrl === 'string') setSetting('ai_base_url', body.aiBaseUrl.trim())
      json(ctx.res, { ok: true, user: admin }, 201)
      return true
    }

    // ---- Admin settings ----

    if (path === '/api/admin/settings' && method === 'GET') {
      if (!requireAdmin(ctx.res, ctx.url.searchParams.get('adminId'))) return true
      const settings = getAllSettings()
      const masked = { ...settings }
      if (masked.ai_api_key && masked.ai_api_key.length > 8)
        masked.ai_api_key = masked.ai_api_key.slice(0, 4) + '...' + masked.ai_api_key.slice(-4)
      if (masked.tmdb_api_key && masked.tmdb_api_key.length > 8)
        masked.tmdb_api_key = masked.tmdb_api_key.slice(0, 4) + '...' + masked.tmdb_api_key.slice(-4)
      json(ctx.res, { settings: masked })
      return true
    }

    if (path === '/api/admin/settings' && method === 'PATCH') {
      const body = await parseBody<Record<string, unknown>>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      for (const key of ['tmdb_api_key', 'ai_provider', 'ai_api_key', 'ai_base_url']) {
        if (typeof body[key] === 'string') setSetting(key, (body[key] as string).trim())
      }
      json(ctx.res, { ok: true })
      return true
    }

    // ---- Users ----

    if (path === '/api/users' && method === 'GET') {
      json(ctx.res, { users: listMediaUsers() })
      return true
    }

    if (path === '/api/users' && method === 'POST') {
      const body = await parseBody<{ adminId?: unknown; name?: unknown; color?: unknown; avatar?: unknown; tasteProfile?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      if (typeof body.name !== 'string' || !body.name.trim()) {
        json(ctx.res, { error: 'name kötelező' }, 400); return true
      }
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
        json(ctx.res, { error: 'color: érvényes hex szín (pl. #3B82F6)' }, 400); return true
      }
      const tasteProfile = typeof body.tasteProfile === 'string' ? body.tasteProfile.trim() || null : null
      const newUser = createMediaUser(body.name.trim(), body.color, typeof body.avatar === 'string' ? body.avatar : null, false, tasteProfile)
      json(ctx.res, { ok: true, user: newUser }, 201)
      return true
    }

    const userStatsMatch = path.match(/^\/api\/users\/(\d+)\/stats$/)
    if (userStatsMatch && method === 'GET') {
      const targetId = parseInt(userStatsMatch[1], 10)
      const user = getMediaUserById(targetId)
      if (!user) { json(ctx.res, { error: 'Felhasználó nem található' }, 404); return true }
      json(ctx.res, { user, stats: getUserStats(targetId) })
      return true
    }

    const userPatchMatch = path.match(/^\/api\/users\/(\d+)$/)
    if (userPatchMatch && method === 'PATCH') {
      const targetId = parseInt(userPatchMatch[1], 10)
      const body = await parseBody<{ adminId?: unknown; userId?: unknown; name?: unknown; color?: unknown; avatar?: unknown; tasteProfile?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      const selfEditId = typeof body.userId === 'number' ? body.userId : NaN
      const isSelfEdit = !isNaN(selfEditId) && selfEditId === targetId && !!getMediaUserById(selfEditId)
      if (!isSelfEdit && !requireAdmin(ctx.res, body.adminId)) return true
      const data: { name?: string; color?: string; avatar?: string | null; tasteProfile?: string | null } = {}
      if (!isSelfEdit) {
        if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
        if (body.avatar !== undefined) data.avatar = typeof body.avatar === 'string' ? body.avatar : null
      }
      if (body.color !== undefined) {
        if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
          json(ctx.res, { error: 'color: érvényes hex szín' }, 400); return true
        }
        data.color = body.color
      }
      if (body.tasteProfile !== undefined) data.tasteProfile = typeof body.tasteProfile === 'string' ? body.tasteProfile.trim() || null : null
      const updated = updateMediaUser(targetId, data)
      if (!updated) { json(ctx.res, { error: 'Felhasználó nem található' }, 404); return true }
      json(ctx.res, { ok: true, user: updated })
      return true
    }

    // ---- Catalog ----

    if (path === '/api/catalog' && method === 'GET') {
      const items = listMediaCatalog().map(item => ({
        ...item,
        genres: flattenJsonStringArray(item.genres),
        cast: flattenJsonStringArray(item.cast, 'name'),
      }))
      json(ctx.res, { items })
      return true
    }

    if (path === '/api/catalog' && method === 'POST') {
      const body = await parseBody<{ userId?: unknown; adminId?: unknown; type?: unknown; title?: unknown; notes?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      const actorId = typeof body.userId === 'number' ? body.userId
        : typeof body.adminId === 'number' ? body.adminId : NaN
      if (isNaN(actorId) || !getMediaUserById(actorId)) {
        json(ctx.res, { error: 'Bejelentkezés szükséges' }, 403); return true
      }
      if (!body.type || !['film', 'series'].includes(body.type as string)) {
        json(ctx.res, { error: 'type kötelező: film vagy series' }, 400); return true
      }
      if (typeof body.title !== 'string' || !body.title.trim()) {
        json(ctx.res, { error: 'title kötelező' }, 400); return true
      }
      const type = body.type as 'film' | 'series'
      const title = (body.title as string).trim()
      const enrichment = await tmdbSearch(type, title)
      const item = createMediaItem({
        type, title, source: 'web',
        poster_url: enrichment.poster_url ?? undefined,
        overview: enrichment.overview ?? undefined,
        year: enrichment.year ?? undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      })
      if (enrichment.tmdb_id) {
        try {
          const [cast, details] = await Promise.all([
            tmdbFetchCast(type, enrichment.tmdb_id),
            tmdbFetchDetails(type, enrichment.tmdb_id),
          ])
          updateMediaItemEnrichment(item.id, {
            tmdb_id: enrichment.tmdb_id,
            cast: cast.length ? JSON.stringify(cast) : null,
            genres: details.genres.length ? JSON.stringify(details.genres) : null,
            runtime: details.runtime ?? null,
          })
        } catch { /* tolerated */ }
      }
      json(ctx.res, { ok: true, item: getMediaItem(item.id)! }, 201)
      return true
    }

    if (path === '/api/catalog/backfill' && method === 'POST') {
      const body = await parseBody<{ adminId?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const updated = await runBackfill(listItemsNeedingEnrichment, updateMediaItemEnrichment)
      json(ctx.res, { ok: true, updated })
      return true
    }

    const catalogItemMatch = path.match(/^\/api\/catalog\/(\d+)$/)

    if (catalogItemMatch && method === 'PATCH') {
      const body = await parseBody<{ adminId?: unknown } & Partial<Pick<MediaItem, 'title' | 'year' | 'poster_url' | 'overview' | 'notes'>>>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const id = parseInt(catalogItemMatch[1], 10)
      const { adminId: _, ...patch } = body
      if (!updateMediaItem(id, patch)) { json(ctx.res, { error: 'Nem található' }, 404); return true }
      json(ctx.res, { ok: true, item: getMediaItem(id) })
      return true
    }

    if (catalogItemMatch && method === 'DELETE') {
      const body = await parseBody<{ adminId?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const id = parseInt(catalogItemMatch[1], 10)
      const result = deleteMediaItem(id)
      if (!result.deleted) { json(ctx.res, { error: 'Nem található' }, 404); return true }
      json(ctx.res, { ok: true, deleted_id: id, title: result.title })
      return true
    }

    const rematchMatch = path.match(/^\/api\/catalog\/(\d+)\/rematch$/)
    if (rematchMatch && method === 'POST') {
      const body = await parseBody<{ adminId?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const id = parseInt(rematchMatch[1], 10)
      const item = getMediaItem(id)
      if (!item) { json(ctx.res, { error: 'Nem található' }, 404); return true }
      const enrichment = await tmdbSearch(item.type, item.title)
      if (!enrichment.tmdb_id) {
        json(ctx.res, { ok: false, message: 'TMDB nem talált egyezést' }); return true
      }
      const [cast, details] = await Promise.all([
        tmdbFetchCast(item.type, enrichment.tmdb_id),
        tmdbFetchDetails(item.type, enrichment.tmdb_id),
      ])
      updateMediaItemEnrichment(id, {
        tmdb_id: enrichment.tmdb_id,
        poster_url: enrichment.poster_url ?? undefined,
        overview: enrichment.overview ?? undefined,
        year: enrichment.year ?? undefined,
        cast: cast.length ? JSON.stringify(cast) : null,
        genres: details.genres.length ? JSON.stringify(details.genres) : null,
        runtime: details.runtime ?? null,
      })
      json(ctx.res, { ok: true, item: getMediaItem(id) })
      return true
    }

    // ---- Status ----

    if (path === '/api/status' && method === 'GET') {
      json(ctx.res, { statuses: getAllMediaUserStatuses() })
      return true
    }

    const statusMatch = path.match(/^\/api\/status\/(\d+)\/(\d+)$/)
    if (statusMatch && method === 'PATCH') {
      const mediaId = parseInt(statusMatch[1], 10)
      const userId = parseInt(statusMatch[2], 10)
      if (!getMediaItem(mediaId)) { json(ctx.res, { error: 'media_id nem található' }, 404); return true }
      if (!getMediaUserById(userId)) { json(ctx.res, { error: 'user_id nem található' }, 404); return true }
      const body = await parseBody<{ state?: string; score?: number | null }>(ctx.req, ctx.res)
      if (!body) return true
      if (body.state !== undefined && !MEDIA_USER_VALID_STATES.has(body.state)) {
        json(ctx.res, { error: `state: ${[...MEDIA_USER_VALID_STATES].join(', ')}` }, 400); return true
      }
      if (body.score !== undefined && body.score !== null) {
        if (typeof body.score !== 'number' || !Number.isInteger(body.score) || body.score < 1 || body.score > 10) {
          json(ctx.res, { error: 'score: 1-10 közötti egész szám' }, 400); return true
        }
      }
      upsertMediaUserStatus(mediaId, userId, { state: body.state, score: body.score })
      const all = getAllMediaUserStatuses()
      const result = all[mediaId]?.[userId] ?? { state: body.state ?? 'none', score: body.score ?? null }
      json(ctx.res, { ok: true, media_id: mediaId, user_id: userId, ...result })
      return true
    }

    // ---- Recommendations ----

    if (path === '/api/recommend' && method === 'GET') {
      const userIdParam = parseInt(ctx.url.searchParams.get('user') ?? '', 10)
      if (isNaN(userIdParam)) { json(ctx.res, { error: 'user paraméter kötelező' }, 400); return true }
      const user = getMediaUserById(userIdParam)
      if (!user) { json(ctx.res, { error: 'user nem található' }, 404); return true }
      const internal = aggregateRecRows(getInternalRecommendations(userIdParam))
      const external = getExternalRecsForUser(user.key, userIdParam)
      json(ctx.res, { internal, external })
      return true
    }

    if (path === '/api/recommend/group' && method === 'GET') {
      const usersParam = ctx.url.searchParams.get('users') ?? ''
      const groupIds = usersParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0)
      if (!groupIds.length) { json(ctx.res, { error: 'users paraméter kötelező' }, 400); return true }
      const groupUsersMaybe = groupIds.map(id => getMediaUserById(id))
      const missing = groupIds.filter((_, i) => !groupUsersMaybe[i])
      if (missing.length) { json(ctx.res, { error: `Ismeretlen user id: ${missing.join(', ')}` }, 404); return true }
      const groupUsers = groupUsersMaybe as NonNullable<ReturnType<typeof getMediaUserById>>[]
      const groupKeys = groupUsers.map(u => u.key)
      const internal = aggregateRecRows(getGroupRecommendations(groupIds)).map(item => ({
        ...item, source: 'internal' as const,
        reason: item.likedBy.map(l => `${l.name} ${l.score}/10`).join(', '),
      }))
      const external = getExternalRecsForGroup(groupKeys, groupIds).map(mr => ({
        id: mr.id, type: mr.type, title: mr.title, year: mr.year,
        poster_url: mr.poster_url, overview: mr.overview,
        source: 'external' as const,
        reason: mr.reason ?? 'AI ajánlotta',
        audience: mr.audience,
      }))
      const watchlist = aggregateWatchlistRows(getGroupWatchlistItems(groupIds))
      json(ctx.res, { internal, external, watchlist })
      return true
    }

    if (path === '/api/recommend/refresh' && method === 'POST') {
      const body = await parseBody<{ userId?: unknown; pickedIds?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      const userId = typeof body.userId === 'number' ? body.userId : NaN
      const user = !isNaN(userId) ? getMediaUserById(userId) : undefined
      if (!user) { json(ctx.res, { error: 'userId nem található' }, 404); return true }

      if (!getSetting('ai_api_key') && !process.env.AI_API_KEY) {
        json(ctx.res, { error: 'AI API kulcs nincs beállítva (admin beállítások)' }, 503); return true
      }

      const pickedIds = Array.isArray(body.pickedIds)
        ? (body.pickedIds as unknown[]).filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0).slice(0, 3)
        : null

      const excludedTitles = getUserExcludedTitles(userId, user.key)
      const exclusionBlock = excludedTitles.length ? excludedTitles.join(', ') : '(nincs kizárandó cím)'
      const tasteDesc = user.taste_profile?.trim() ? `User's own taste description: ${user.taste_profile.trim()}` : ''

      let task: string
      let profileHeader: string
      let profileLines: string

      if (pickedIds && pickedIds.length > 0) {
        const pickedItems = pickedIds.map(id => getMediaItem(id)).filter((item): item is MediaItem => !!item)
        task = 'recommend 8-10 films and/or series similar in style, theme, and feel to these titles the user loved:'
        profileHeader = 'Reference titles:'
        profileLines = pickedItems.map(item => {
          const genres = item.genres ? (() => { try { return (JSON.parse(item.genres!) as Array<{name?:string}>).map(g => g.name ?? String(g)).join(', ') } catch { return item.genres } })() : ''
          return `- ${item.title}${item.year ? ` (${item.year})` : ''}${genres ? ` [${genres}]` : ''}`
        }).join('\n') || '(no items)'
      } else {
        const seenProfile = getUserSeenProfile(userId)
        task = 'recommend 8-10 films and/or series for a user based on their taste profile below.'
        profileHeader = 'Rated titles (title, score/10, genres):'
        profileLines = seenProfile.length
          ? seenProfile.map(it => {
              const genres = it.genres ? (() => { try { return (JSON.parse(it.genres!) as Array<{name?:string}>).map(g => g.name ?? g).join(', ') } catch { return it.genres } })() : ''
              return `- ${it.title} (${it.score}/10)${genres ? ` [${genres}]` : ''}`
            }).join('\n')
          : '(nincs értékelt film/sorozat még)'
      }

      const prompt = [
        'You are a film and TV series recommendation engine. Respond with ONLY a valid JSON array — no markdown, no explanation, no code fences.',
        '',
        `Task: ${task}`,
        '',
        profileHeader,
        profileLines,
        ...(tasteDesc ? ['', tasteDesc] : []),
        '',
        'EXCLUSION LIST — do NOT recommend any title on this list:',
        exclusionBlock,
        '',
        'Rules:',
        '- Mix films and series (type: "film" or "series")',
        '- Only real, existing titles',
        '- Do NOT include any title from the exclusion list',
        '- title field: use the well-known international (usually English) title so it can be looked up in TMDB',
        '- reason field must be in Hungarian, 1 sentence',
        '- year field: release year as integer, or null if unknown',
        '',
        'JSON format (array only, no wrapper):',
        '[{"type":"film","title":"Example Title","year":2019,"reason":"Magyar indoklás."}]',
      ].join('\n')

      let rawRecs: Array<{ type: 'film' | 'series'; title: string; year: number | null; reason: string }>
      try {
        rawRecs = await generateRecommendations(prompt, 60_000)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        json(ctx.res, { error: `AI hívás sikertelen: ${msg}` }, 502)
        return true
      }

      if (!rawRecs.length) {
        json(ctx.res, { ok: false, error: 'AI 0 ajánlást adott vissza' }, 502)
        return true
      }

      const enriched = await Promise.all(rawRecs.map(async rec => {
        let enrichment = { title: null as string | null, poster_url: null as string | null, overview: null as string | null, year: rec.year }
        try {
          const tmdb = await Promise.race([
            tmdbSearch(rec.type, rec.title),
            new Promise<never>((_, rej) =>
              AbortSignal.timeout(5_000).addEventListener('abort', () => rej(new Error('TMDB timeout')), { once: true })
            ),
          ])
          enrichment = { title: tmdb.title, poster_url: tmdb.poster_url, overview: tmdb.overview, year: tmdb.year ?? rec.year }
        } catch { /* tolerated */ }
        return { type: rec.type, title: enrichment.title ?? rec.title, year: enrichment.year, reason: rec.reason || null, poster_url: enrichment.poster_url, overview: enrichment.overview, source: 'ai' }
      }))

      const count = replaceMediaRecommendations(user.key, enriched)
      json(ctx.res, { ok: true, count })
      return true
    }

    if (path === '/api/recommendations' && method === 'GET') {
      const audience = ctx.url.searchParams.get('audience') ?? undefined
      json(ctx.res, { recommendations: listMediaRecommendations(audience) })
      return true
    }

    if (path === '/api/recommendations' && method === 'POST') {
      const body = await parseBody<{ adminId?: unknown; audience?: unknown; items?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      if (typeof body.audience !== 'string' || !body.audience.trim()) {
        json(ctx.res, { error: 'audience kötelező' }, 400); return true
      }
      if (!Array.isArray(body.items)) {
        json(ctx.res, { error: 'items kötelező (array)' }, 400); return true
      }
      const count = replaceMediaRecommendations(body.audience.trim(), body.items as Parameters<typeof replaceMediaRecommendations>[1])
      json(ctx.res, { ok: true, audience: body.audience, count })
      return true
    }

    const recActMatch = path.match(/^\/api\/recommendations\/(\d+)\/act$/)
    if (recActMatch && method === 'POST') {
      const recId = parseInt(recActMatch[1], 10)
      const body = await parseBody<{ userId?: unknown; state?: unknown; score?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      const userId = typeof body.userId === 'number' ? body.userId : NaN
      if (isNaN(userId) || !getMediaUserById(userId)) {
        json(ctx.res, { error: 'userId nem található' }, 404); return true
      }
      const state = typeof body.state === 'string' ? body.state : undefined
      if (!state || !MEDIA_USER_VALID_STATES.has(state)) {
        json(ctx.res, { error: `state kötelező: ${[...MEDIA_USER_VALID_STATES].join(', ')}` }, 400); return true
      }
      if (body.score !== undefined && body.score !== null) {
        if (typeof body.score !== 'number' || !Number.isInteger(body.score) || body.score < 1 || body.score > 10) {
          json(ctx.res, { error: 'score: 1-10 közötti egész szám' }, 400); return true
        }
      }
      const score = typeof body.score === 'number' ? body.score : null
      const rec = getMediaRecommendationById(recId)
      if (!rec) { json(ctx.res, { error: 'Ajánlás nem található' }, 404); return true }
      let mediaItem = findMediaItemByTitleYear(rec.title, rec.year)
      if (!mediaItem) {
        mediaItem = createMediaItem({ type: rec.type as 'film' | 'series', title: rec.title, year: rec.year ?? undefined, source: 'web', poster_url: rec.poster_url ?? undefined, overview: rec.overview ?? undefined })
        const needsEnrich = !rec.poster_url || !rec.overview
        if (needsEnrich) {
          try {
            const enrichment = await tmdbSearch(mediaItem.type, mediaItem.title)
            if (enrichment.tmdb_id) {
              const [cast, details] = await Promise.all([tmdbFetchCast(mediaItem.type, enrichment.tmdb_id), tmdbFetchDetails(mediaItem.type, enrichment.tmdb_id)])
              updateMediaItemEnrichment(mediaItem.id, { tmdb_id: enrichment.tmdb_id, poster_url: rec.poster_url ? undefined : (enrichment.poster_url ?? undefined), overview: rec.overview ? undefined : (enrichment.overview ?? undefined), year: rec.year ? undefined : (enrichment.year ?? undefined), cast: cast.length ? JSON.stringify(cast) : null, genres: details.genres.length ? JSON.stringify(details.genres) : null, runtime: details.runtime ?? null })
              mediaItem = getMediaItem(mediaItem.id)!
            }
          } catch { /* tolerated */ }
        }
      }
      upsertMediaUserStatus(mediaItem.id, userId, { state, score: score ?? undefined })
      json(ctx.res, { ok: true, media_id: mediaItem.id, item: getMediaItem(mediaItem.id) })
      return true
    }

    // ---- Admin: media path ----

    if (path === '/api/admin/media-path' && method === 'GET') {
      if (!requireAdmin(ctx.res, ctx.url.searchParams.get('adminId'))) return true
      const { readFile } = await import('fs/promises')
      let mediaPath = ''
      try {
        const env = await readFile('/app/hostconfig/.env', 'utf8')
        const match = env.match(/^MEDIA_PATH=(.*)$/m)
        if (match) mediaPath = match[1].trim()
      } catch { /* no .env yet */ }
      json(ctx.res, { mediaPath })
      return true
    }

    if (path === '/api/admin/media-path' && method === 'PATCH') {
      const body = await parseBody<{ adminId?: unknown; mediaPath?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const mediaPath = typeof body.mediaPath === 'string' ? body.mediaPath.trim() : ''
      const { readFile, writeFile } = await import('fs/promises')
      try {
        let env = ''
        try { env = await readFile('/app/hostconfig/.env', 'utf8') } catch { /* new file */ }
        if (/^MEDIA_PATH=/m.test(env)) {
          env = env.replace(/^MEDIA_PATH=.*$/m, `MEDIA_PATH=${mediaPath}`)
        } else {
          env = env ? `${env.trimEnd()}\nMEDIA_PATH=${mediaPath}\n` : `MEDIA_PATH=${mediaPath}\n`
        }
        await writeFile('/app/hostconfig/.env', env, 'utf8')
        json(ctx.res, { ok: true, mediaPath, restartRequired: true })
      } catch (err) {
        json(ctx.res, { error: `Nem lehet írni: ${(err as Error).message}` }, 500)
      }
      return true
    }

    // ---- Media scan ----

    if (path === '/api/media-scan' && method === 'POST') {
      const body = await parseBody<{ adminId?: unknown }>(ctx.req, ctx.res)
      if (!body) return true
      if (!requireAdmin(ctx.res, body.adminId)) return true
      const { readdir } = await import('fs/promises')
      const { join, extname, basename, dirname } = await import('path')
      const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts'])

      async function collectByDir(dir: string, depth = 0): Promise<Map<string, string[]>> {
        const result = new Map<string, string[]>()
        if (depth > 4) return result
        let entries: import('fs').Dirent[]
        try { entries = await readdir(dir, { withFileTypes: true }) as import('fs').Dirent[] } catch { return result }
        const localVideos: string[] = []
        for (const e of entries) {
          const name = String(e.name)
          if (e.isDirectory()) {
            const sub = await collectByDir(join(dir, name), depth + 1)
            sub.forEach((v, k) => result.set(k, v))
          } else if (e.isFile() && VIDEO_EXTS.has(extname(name).toLowerCase())) {
            localVideos.push(join(dir, name))
          }
        }
        if (localVideos.length > 0) result.set(dir, localVideos)
        return result
      }

      function cleanTitle(raw: string): { title: string; year: number | null } {
        let name = raw.replace(/\[.*?\]/g, '').trim()
        const yearMatch = name.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)
        const year = yearMatch ? parseInt(yearMatch[1], 10) : null
        let title = name
          .replace(/(?:19|20)\d{2}.*$/, '')
          .replace(/\b(?:1080p|720p|2160p|4K|HDR|BluRay|BDRip|WEB|WEBRip|HDTV|x264|x265|HEVC|AAC|DTS|AC3|REMUX)\b.*/i, '')
          .replace(/[._\-]+/g, ' ')
          .trim()
        if (!title) title = raw.replace(/[._\-]+/g, ' ').trim()
        return { title, year }
      }

      const MEDIA_DIR = '/media'
      const byDir = await collectByDir(MEDIA_DIR)
      if (byDir.size === 0) {
        json(ctx.res, { ok: true, added: 0, skipped: 0, message: 'Üres mappa vagy nincs csatolva (MEDIA_PATH)' })
        return true
      }

      type Candidate = { rawName: string; title: string; year: number | null; type: 'film' | 'series' }
      const candidates: Candidate[] = []
      for (const [dir, files] of byDir) {
        if (dir === MEDIA_DIR) {
          for (const f of files) {
            const rawName = basename(f, extname(f))
            const { title, year } = cleanTitle(rawName)
            candidates.push({ rawName, title, year, type: 'film' })
          }
        } else {
          const dirName = basename(dir)
          const parentDir = basename(dirname(dir))
          const isSeasonDir = /^(season|évad|sorozat|series|s)\s*\d+$/i.test(dirName) || /^S\d{2}$/i.test(dirName)
          if (isSeasonDir) {
            const { title, year } = cleanTitle(parentDir)
            candidates.push({ rawName: parentDir, title, year, type: 'series' })
          } else if (files.length > 1) {
            const { title, year } = cleanTitle(dirName)
            candidates.push({ rawName: dirName, title, year, type: 'series' })
          } else {
            const rawName = basename(files[0], extname(files[0]))
            const { title, year } = cleanTitle(rawName)
            candidates.push({ rawName, title, year, type: 'film' })
          }
        }
      }

      type MissedItem = { rawName: string; title: string; year: number | null; type: string; reason: string }
      let added = 0; let skipped = 0
      const missed: MissedItem[] = []
      const seen = new Set<string>()
      const seenTmdbIds = new Set<number>()
      for (const { rawName, title, year, type } of candidates) {
        const key = `${title.toLowerCase()}|${year ?? ''}`
        if (seen.has(key)) { skipped++; continue }
        seen.add(key)
        let tmdbResult: Awaited<ReturnType<typeof tmdbSearch>> | null = null
        try { tmdbResult = await tmdbSearch(type, title) } catch { /* tolerated */ }
        if (tmdbResult?.tmdb_id) {
          if (seenTmdbIds.has(tmdbResult.tmdb_id) || findMediaItemByTmdbId(tmdbResult.tmdb_id)) { skipped++; continue }
          seenTmdbIds.add(tmdbResult.tmdb_id)
        } else {
          const existingTitle = findMediaItemByTitleYear(title, year)
          if (existingTitle) { skipped++; continue }
          missed.push({ rawName, title, year, type, reason: 'Nem találtam TMDB-n' })
          continue
        }
        const finalTitle = tmdbResult.title ?? title
        const item = createMediaItem({ type, title: finalTitle, year: (tmdbResult.year ?? year) ?? undefined, source: 'scan' })
        try {
          const [cast, details] = await Promise.all([tmdbFetchCast(type, tmdbResult.tmdb_id), tmdbFetchDetails(type, tmdbResult.tmdb_id)])
          updateMediaItemEnrichment(item.id, { tmdb_id: tmdbResult.tmdb_id, poster_url: tmdbResult.poster_url ?? undefined, overview: tmdbResult.overview ?? undefined, year: tmdbResult.year ?? undefined, cast: cast.length ? JSON.stringify(cast) : null, genres: details.genres.length ? JSON.stringify(details.genres) : null, runtime: details.runtime ?? null })
        } catch { /* tolerated */ }
        added++
      }
      json(ctx.res, { ok: true, added, skipped, total: candidates.length, missed })
      return true
    }

  } catch {
    json(ctx.res, { error: 'Szerver hiba' }, 500)
    return true
  }

  return false
}
