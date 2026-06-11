import {
  listMediaUsers, getMediaUserById, getAllMediaUserStatuses,
  upsertMediaUserStatus, getMediaItem, listMediaCatalog, deleteMediaItem,
  getInternalRecommendations, getExternalRecsForUser,
  getGroupRecommendations, getExternalRecsForGroup, getGroupWatchlistItems,
  createMediaUser, updateMediaUser,
  createMediaItem, updateMediaItem, updateMediaItemEnrichment,
  listMediaRecommendations, replaceMediaRecommendations,
  getMediaRecommendationById, findMediaItemByTitleYear,
  getUserSeenProfile, getUserExcludedTitles,
  listItemsNeedingEnrichment,
  findMediaItemByTmdbId,
  getAllSettings, getSetting, setSetting,
  hasAnyUsers,
  MEDIA_USER_VALID_STATES,
  type RecRow, type WatchlistRow, type MediaItem,
} from '../db.js'
import { tmdbSearch, tmdbFetchCast, tmdbFetchDetails, runBackfill } from '../tmdb.js'
import { generateRecommendations } from '../ai.js'
import { json, readBody } from './helpers.js'
import type { RouteContext } from './types.js'

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

    // GET /api/setup/status
    if (path === '/api/setup/status' && method === 'GET') {
      const needsSetup = !hasAnyUsers()
      json(ctx.res, { needsSetup })
      return true
    }

    // POST /api/setup -- first-run: create admin user + save API keys
    if (path === '/api/setup' && method === 'POST') {
      if (hasAnyUsers()) {
        json(ctx.res, { error: 'Már be van állítva' }, 400); return true
      }
      let body: { name?: unknown; color?: unknown; tmdbKey?: unknown; aiProvider?: unknown; aiKey?: unknown; aiBaseUrl?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
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

    // GET /api/admin/settings?adminId=<id>
    if (path === '/api/admin/settings' && method === 'GET') {
      const adminId = parseInt(ctx.url.searchParams.get('adminId') ?? '', 10)
      if (isNaN(adminId) || !getMediaUserById(adminId)?.is_admin) {
        json(ctx.res, { error: 'Csak admin férhet hozzá' }, 403); return true
      }
      const settings = getAllSettings()
      // Mask API keys partially
      const masked = { ...settings }
      if (masked.ai_api_key && masked.ai_api_key.length > 8) {
        masked.ai_api_key = masked.ai_api_key.slice(0, 4) + '...' + masked.ai_api_key.slice(-4)
      }
      if (masked.tmdb_api_key && masked.tmdb_api_key.length > 8) {
        masked.tmdb_api_key = masked.tmdb_api_key.slice(0, 4) + '...' + masked.tmdb_api_key.slice(-4)
      }
      json(ctx.res, { settings: masked })
      return true
    }

    // PATCH /api/admin/settings -- update one or more settings
    if (path === '/api/admin/settings' && method === 'PATCH') {
      let body: Record<string, unknown>
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      const adminId = typeof body.adminId === 'number' ? body.adminId : NaN
      if (isNaN(adminId) || !getMediaUserById(adminId)?.is_admin) {
        json(ctx.res, { error: 'Csak admin módosíthat beállítást' }, 403); return true
      }
      const allowed = ['tmdb_api_key', 'ai_provider', 'ai_api_key', 'ai_base_url']
      for (const key of allowed) {
        if (typeof body[key] === 'string') setSetting(key, (body[key] as string).trim())
      }
      json(ctx.res, { ok: true })
      return true
    }

    // ---- Users ----

    // GET /api/users
    if (path === '/api/users' && method === 'GET') {
      json(ctx.res, { users: listMediaUsers() })
      return true
    }

    // POST /api/users
    if (path === '/api/users' && method === 'POST') {
      let body: { adminId?: unknown; name?: unknown; color?: unknown; avatar?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      if (isNaN(typeof body.adminId === 'number' ? body.adminId : NaN) || !getMediaUserById(body.adminId as number)?.is_admin) {
        json(ctx.res, { error: 'Csak admin hozhat létre felhasználót' }, 403); return true
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        json(ctx.res, { error: 'name kötelező' }, 400); return true
      }
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
        json(ctx.res, { error: 'color: érvényes hex szín (pl. #3B82F6)' }, 400); return true
      }
      const newUser = createMediaUser(body.name.trim(), body.color, typeof body.avatar === 'string' ? body.avatar : null)
      json(ctx.res, { ok: true, user: newUser }, 201)
      return true
    }

    // PATCH /api/users/:id
    const userPatchMatch = path.match(/^\/api\/users\/(\d+)$/)
    if (userPatchMatch && method === 'PATCH') {
      const targetId = parseInt(userPatchMatch[1], 10)
      let body: { adminId?: unknown; name?: unknown; color?: unknown; avatar?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      const adminId = typeof body.adminId === 'number' ? body.adminId : NaN
      if (isNaN(adminId) || !getMediaUserById(adminId)?.is_admin) {
        json(ctx.res, { error: 'Csak admin szerkeszthet felhasználót' }, 403); return true
      }
      const data: { name?: string; color?: string; avatar?: string | null } = {}
      if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
      if (body.color !== undefined) {
        if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
          json(ctx.res, { error: 'color: érvényes hex szín' }, 400); return true
        }
        data.color = body.color
      }
      if (body.avatar !== undefined) data.avatar = typeof body.avatar === 'string' ? body.avatar : null
      const updated = updateMediaUser(targetId, data)
      if (!updated) { json(ctx.res, { error: 'Felhasználó nem található' }, 404); return true }
      json(ctx.res, { ok: true, user: updated })
      return true
    }

    // ---- Catalog ----

    // GET /api/catalog
    if (path === '/api/catalog' && method === 'GET') {
      const items = listMediaCatalog().map(item => ({
        ...item,
        genres: flattenJsonStringArray(item.genres),
        cast: flattenJsonStringArray(item.cast, 'name'),
      }))
      json(ctx.res, { items })
      return true
    }

    // POST /api/catalog
    if (path === '/api/catalog' && method === 'POST') {
      let body: { adminId?: unknown; type?: unknown; title?: unknown; notes?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin adhat hozzá tételt' }, 403); return true
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

    // PATCH /api/catalog/:id
    const catalogPatchMatch = path.match(/^\/api\/catalog\/(\d+)$/)
    if (catalogPatchMatch && method === 'PATCH') {
      let body: { adminId?: unknown } & Partial<Pick<MediaItem, 'title' | 'year' | 'poster_url' | 'overview' | 'notes'>>
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin szerkeszthet tételt' }, 403); return true
      }
      const id = parseInt(catalogPatchMatch[1], 10)
      const { adminId: _, ...patch } = body
      if (!updateMediaItem(id, patch)) {
        json(ctx.res, { error: 'Nem található' }, 404); return true
      }
      json(ctx.res, { ok: true, item: getMediaItem(id) })
      return true
    }

    // POST /api/catalog/:id/rematch
    const rematchMatch = path.match(/^\/api\/catalog\/(\d+)\/rematch$/)
    if (rematchMatch && method === 'POST') {
      let body: { adminId?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch { body = {} }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin végezhet rematch-et' }, 403); return true
      }
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

    // POST /api/catalog/backfill
    if (path === '/api/catalog/backfill' && method === 'POST') {
      let body: { adminId?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch { body = {} }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin futtathat backfill-t' }, 403); return true
      }
      const updated = await runBackfill(listItemsNeedingEnrichment, updateMediaItemEnrichment)
      json(ctx.res, { ok: true, updated })
      return true
    }

    // DELETE /api/catalog/:id
    const catalogDeleteMatch = path.match(/^\/api\/catalog\/(\d+)$/)
    if (catalogDeleteMatch && method === 'DELETE') {
      let body: { adminId?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      const adminId = typeof body.adminId === 'number' ? body.adminId : NaN
      if (isNaN(adminId) || !getMediaUserById(adminId)?.is_admin) {
        json(ctx.res, { error: 'Csak admin törölhet' }, 403); return true
      }
      const id = parseInt(catalogDeleteMatch[1], 10)
      const result = deleteMediaItem(id)
      if (!result.deleted) { json(ctx.res, { error: 'Nem található' }, 404); return true }
      json(ctx.res, { ok: true, deleted_id: id, title: result.title })
      return true
    }

    // ---- Status ----

    // GET /api/status
    if (path === '/api/status' && method === 'GET') {
      json(ctx.res, { statuses: getAllMediaUserStatuses() })
      return true
    }

    // PATCH /api/status/:media_id/:user_id
    const statusMatch = path.match(/^\/api\/status\/(\d+)\/(\d+)$/)
    if (statusMatch && method === 'PATCH') {
      const mediaId = parseInt(statusMatch[1], 10)
      const userId = parseInt(statusMatch[2], 10)
      if (!getMediaItem(mediaId)) { json(ctx.res, { error: 'media_id nem található' }, 404); return true }
      if (!getMediaUserById(userId)) { json(ctx.res, { error: 'user_id nem található' }, 404); return true }
      let body: { state?: string; score?: number | null }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
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

    // GET /api/recommend?user=<id>
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

    // GET /api/recommend/group?users=1,2,...
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

    // POST /api/recommend/refresh -- LLM-based rec regeneration
    if (path === '/api/recommend/refresh' && method === 'POST') {
      let body: { userId?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      const userId = typeof body.userId === 'number' ? body.userId : NaN
      const user = !isNaN(userId) ? getMediaUserById(userId) : undefined
      if (!user) { json(ctx.res, { error: 'userId nem található' }, 404); return true }

      if (!getSetting('ai_api_key') && !process.env.AI_API_KEY) {
        json(ctx.res, { error: 'AI API kulcs nincs beállítva (admin beállítások)' }, 503); return true
      }

      const seenProfile = getUserSeenProfile(userId)
      const excludedTitles = getUserExcludedTitles(userId, user.key)

      const profileLines = seenProfile.length
        ? seenProfile.map(it => {
            const genres = it.genres ? (() => { try { return (JSON.parse(it.genres!) as Array<{name?:string}>).map(g => g.name ?? g).join(', ') } catch { return it.genres } })() : ''
            return `- ${it.title} (${it.score}/10)${genres ? ` [${genres}]` : ''}`
          }).join('\n')
        : '(nincs értékelt film/sorozat még)'

      const exclusionBlock = excludedTitles.length ? excludedTitles.join(', ') : '(nincs kizárandó cím)'

      const prompt = [
        'You are a film and TV series recommendation engine. Respond with ONLY a valid JSON array — no markdown, no explanation, no code fences.',
        '',
        'Task: recommend 8-10 films and/or series for a user based on their taste profile below.',
        '',
        'Taste profile (title, score/10, genres):',
        profileLines,
        '',
        'EXCLUSION LIST — do NOT recommend any title on this list:',
        exclusionBlock,
        '',
        'Rules:',
        '- Mix films and series (type: "film" or "series")',
        '- Only real, existing titles',
        '- Do NOT include any title from the exclusion list',
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
        let enrichment = { poster_url: null as string | null, overview: null as string | null, year: rec.year }
        try {
          const tmdb = await Promise.race([
            tmdbSearch(rec.type, rec.title),
            new Promise<never>((_, rej) =>
              AbortSignal.timeout(5_000).addEventListener('abort', () => rej(new Error('TMDB timeout')), { once: true })
            ),
          ])
          enrichment = { poster_url: tmdb.poster_url, overview: tmdb.overview, year: tmdb.year ?? rec.year }
        } catch { /* tolerated */ }
        return { type: rec.type, title: rec.title, year: enrichment.year, reason: rec.reason || null, poster_url: enrichment.poster_url, overview: enrichment.overview, source: 'ai' }
      }))

      const count = replaceMediaRecommendations(user.key, enriched)
      json(ctx.res, { ok: true, count })
      return true
    }

    // GET /api/recommendations?audience=...
    if (path === '/api/recommendations' && method === 'GET') {
      const audience = ctx.url.searchParams.get('audience') ?? undefined
      json(ctx.res, { recommendations: listMediaRecommendations(audience) })
      return true
    }

    // POST /api/recommendations (admin: replace for audience)
    if (path === '/api/recommendations' && method === 'POST') {
      let body: { adminId?: unknown; audience?: unknown; items?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin szerkeszthet ajánlásokat' }, 403); return true
      }
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

    // POST /api/recommendations/:recId/act
    const recActMatch = path.match(/^\/api\/recommendations\/(\d+)\/act$/)
    if (recActMatch && method === 'POST') {
      const recId = parseInt(recActMatch[1], 10)
      let body: { userId?: unknown; state?: unknown; score?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
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

    // GET /api/admin/media-path -- read current MEDIA_PATH from .env
    if (path === '/api/admin/media-path' && method === 'GET') {
      const adminId = parseInt(ctx.url.searchParams.get('adminId') ?? '', 10)
      if (isNaN(adminId) || !getMediaUserById(adminId)?.is_admin) {
        json(ctx.res, { error: 'Csak admin férhet hozzá' }, 403); return true
      }
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

    // PATCH /api/admin/media-path -- write MEDIA_PATH to .env
    if (path === '/api/admin/media-path' && method === 'PATCH') {
      let body: { adminId?: unknown; mediaPath?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch {
        json(ctx.res, { error: 'Érvénytelen JSON' }, 400); return true
      }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin módosíthat' }, 403); return true
      }
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

    // POST /api/media-scan -- scan /media folder and import video files
    if (path === '/api/media-scan' && method === 'POST') {
      let body: { adminId?: unknown }
      try { body = JSON.parse((await readBody(ctx.req)).toString()) } catch { body = {} }
      if (!getMediaUserById(typeof body.adminId === 'number' ? body.adminId : NaN)?.is_admin) {
        json(ctx.res, { error: 'Csak admin futtathatja' }, 403); return true
      }
      const { readdir } = await import('fs/promises')
      const { join, extname, basename, dirname, relative } = await import('path')
      const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts'])

      // Collect video files grouped by their immediate parent directory
      // Returns Map<dirPath, string[]> (dir -> list of video files in that dir)
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

      // Build candidate list: folders with >1 video = series (use folder name); single file = film (use filename)
      type Candidate = { title: string; year: number | null; type: 'film' | 'series' }
      const candidates: Candidate[] = []
      for (const [dir, files] of byDir) {
        if (dir === MEDIA_DIR) {
          // Files directly in root: each is its own film
          for (const f of files) {
            const { title, year } = cleanTitle(basename(f, extname(f)))
            candidates.push({ title, year, type: 'film' })
          }
        } else {
          const dirName = basename(dir)
          const parentDir = basename(dirname(dir))
          // If parent dir is a season folder (Season 1, S01, Évad 1, etc.), go up one more
          const isSeasonDir = /^(season|évad|sorozat|series|s)\s*\d+$/i.test(dirName) || /^S\d{2}$/i.test(dirName)
          if (isSeasonDir) {
            // The grandparent dir name is the series title
            const { title, year } = cleanTitle(parentDir)
            candidates.push({ title, year, type: 'series' })
          } else if (files.length > 1) {
            // Multiple files in a non-season folder = series, use folder name
            const { title, year } = cleanTitle(dirName)
            candidates.push({ title, year, type: 'series' })
          } else {
            // Single file in a subfolder: use file name, likely a film in its own folder
            const { title, year } = cleanTitle(basename(files[0], extname(files[0])))
            candidates.push({ title, year, type: 'film' })
          }
        }
      }

      // Dedup by (title, year) and import
      let added = 0; let skipped = 0
      const seen = new Set<string>()
      const seenTmdbIds = new Set<number>()
      for (const { title, year, type } of candidates) {
        const key = `${title.toLowerCase()}|${year ?? ''}`
        if (seen.has(key)) { skipped++; continue }
        seen.add(key)
        // TMDB lookup first -- dedup by tmdb_id (catches "hrt project almanac" vs "Az Almanach Projekt" etc.)
        let tmdbResult: Awaited<ReturnType<typeof tmdbSearch>> | null = null
        try { tmdbResult = await tmdbSearch(type, title) } catch { /* tolerated */ }
        if (tmdbResult?.tmdb_id) {
          if (seenTmdbIds.has(tmdbResult.tmdb_id) || findMediaItemByTmdbId(tmdbResult.tmdb_id)) { skipped++; continue }
          seenTmdbIds.add(tmdbResult.tmdb_id)
        } else {
          if (findMediaItemByTitleYear(title, year)) { skipped++; continue }
        }
        const item = createMediaItem({ type, title, year: (tmdbResult?.year ?? year) ?? undefined, source: 'scan' })
        if (tmdbResult?.tmdb_id) {
          try {
            const [cast, details] = await Promise.all([tmdbFetchCast(type, tmdbResult.tmdb_id), tmdbFetchDetails(type, tmdbResult.tmdb_id)])
            updateMediaItemEnrichment(item.id, { tmdb_id: tmdbResult.tmdb_id, poster_url: tmdbResult.poster_url ?? undefined, overview: tmdbResult.overview ?? undefined, year: tmdbResult.year ?? undefined, cast: cast.length ? JSON.stringify(cast) : null, genres: details.genres.length ? JSON.stringify(details.genres) : null, runtime: details.runtime ?? null })
          } catch { /* tolerated */ }
        }
        added++
      }
      json(ctx.res, { ok: true, added, skipped, total: candidates.length })
      return true
    }

  } catch {
    json(ctx.res, { error: 'Szerver hiba' }, 500)
    return true
  }

  return false
}
