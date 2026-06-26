import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DB_PATH } from './config.js'

const dbPath = resolve(process.cwd(), DB_PATH)
mkdirSync(dirname(dbPath), { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('film', 'series')),
    title TEXT NOT NULL,
    year INTEGER,
    poster_url TEXT,
    overview TEXT,
    tmdb_id INTEGER,
    "cast" TEXT,
    genres TEXT,
    runtime INTEGER,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'web',
    needs_review INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(title COLLATE NOCASE)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_items_tmdb_id ON media_items(tmdb_id) WHERE tmdb_id IS NOT NULL`)

db.exec(`
  CREATE TABLE IF NOT EXISTS media_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    avatar TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    taste_profile TEXT,
    created_at INTEGER NOT NULL
  )
`)
try { db.exec(`ALTER TABLE media_users ADD COLUMN taste_profile TEXT`) } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS media_user_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES media_users(id),
    state TEXT NOT NULL DEFAULT 'none' CHECK(state IN ('seen','watchlist','not_interested','in_progress','none')),
    score INTEGER CHECK(score IS NULL OR (score >= 1 AND score <= 10)),
    updated_at INTEGER NOT NULL,
    UNIQUE(media_id, user_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_mus_media_id ON media_user_status(media_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_mus_user_id ON media_user_status(user_id)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS media_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('film', 'series')),
    title TEXT NOT NULL,
    year INTEGER,
    reason TEXT,
    poster_url TEXT,
    overview TEXT,
    source TEXT NOT NULL DEFAULT 'ai',
    audience TEXT NOT NULL DEFAULT 'kozos',
    created_at INTEGER NOT NULL
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_media_recs_audience ON media_recommendations(audience)`)

// App settings (API keys, etc.) stored in DB so admin can update via UI
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

// --- Types ---

export interface MediaItem {
  id: number
  type: 'film' | 'series'
  title: string
  year: number | null
  poster_url: string | null
  overview: string | null
  tmdb_id: number | null
  cast: string | null
  genres: string | null
  runtime: number | null
  notes: string | null
  source: string
  needs_review: number
  created_at: number
  updated_at: number
}

export interface MediaUser {
  id: number
  key: string
  name: string
  color: string
  avatar: string | null
  is_admin: number
  taste_profile: string | null
  created_at: number
}

export interface MediaRecommendation {
  id: number
  type: string
  title: string
  year: number | null
  reason: string | null
  poster_url: string | null
  overview: string | null
  source: string
  audience: string
  created_at: number
}

export interface RecRow {
  id: number; type: string; title: string; year: number | null
  poster_url: string | null; overview: string | null; tmdb_id: number | null
  runtime: number | null; genres: string | null; cast: string | null
  liker_name: string; liker_user_id: number; liker_score: number
}

export interface WatchlistRow {
  id: number; type: string; title: string; year: number | null
  poster_url: string | null; overview: string | null; tmdb_id: number | null
  runtime: number | null; genres: string | null; cast: string | null
  watcher_name: string; watcher_user_id: number
}

export const MEDIA_USER_VALID_STATES = new Set(['seen', 'watchlist', 'not_interested', 'in_progress', 'none'])

// --- Settings ---

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// --- Media Items ---

export function listMediaCatalog(): MediaItem[] {
  return db.prepare('SELECT * FROM media_items WHERE needs_review = 0 ORDER BY type, title COLLATE NOCASE').all() as MediaItem[]
}

export function getMediaItem(id: number): MediaItem | undefined {
  return db.prepare('SELECT * FROM media_items WHERE id = ?').get(id) as MediaItem | undefined
}

export function createMediaItem(data: {
  type: 'film' | 'series'; title: string; year?: number
  poster_url?: string; overview?: string; notes?: string; source?: string
}): MediaItem {
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(`
    INSERT INTO media_items (type, title, year, poster_url, overview, notes, source, needs_review, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(data.type, data.title, data.year ?? null, data.poster_url ?? null, data.overview ?? null,
         data.notes ?? null, data.source ?? 'web', now, now)
  return db.prepare('SELECT * FROM media_items WHERE id = ?').get(result.lastInsertRowid) as MediaItem
}

export function updateMediaItem(id: number, data: Partial<Pick<MediaItem, 'title' | 'year' | 'poster_url' | 'overview' | 'notes'>>): boolean {
  const sets: string[] = []
  const values: unknown[] = []
  if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title) }
  if (data.year !== undefined) { sets.push('year = ?'); values.push(data.year) }
  if (data.poster_url !== undefined) { sets.push('poster_url = ?'); values.push(data.poster_url) }
  if (data.overview !== undefined) { sets.push('overview = ?'); values.push(data.overview) }
  if (data.notes !== undefined) { sets.push('notes = ?'); values.push(data.notes) }
  if (!sets.length) return false
  sets.push('updated_at = ?'); values.push(Math.floor(Date.now() / 1000))
  values.push(id)
  return db.prepare(`UPDATE media_items SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes > 0
}

export function updateMediaItemEnrichment(id: number, data: {
  tmdb_id?: number; poster_url?: string; overview?: string; year?: number
  cast?: string | null; genres?: string | null; runtime?: number | null
}): boolean {
  const sets: string[] = []
  const values: unknown[] = []
  if (data.tmdb_id !== undefined) { sets.push('tmdb_id = ?'); values.push(data.tmdb_id) }
  if (data.poster_url !== undefined) { sets.push('poster_url = ?'); values.push(data.poster_url) }
  if (data.overview !== undefined) { sets.push('overview = ?'); values.push(data.overview) }
  if (data.year !== undefined) { sets.push('year = ?'); values.push(data.year) }
  if (data.cast !== undefined) { sets.push('"cast" = ?'); values.push(data.cast) }
  if (data.genres !== undefined) { sets.push('genres = ?'); values.push(data.genres) }
  if (data.runtime !== undefined) { sets.push('runtime = ?'); values.push(data.runtime) }
  if (!sets.length) return false
  sets.push('updated_at = ?'); values.push(Math.floor(Date.now() / 1000))
  values.push(id)
  return db.prepare(`UPDATE media_items SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes > 0
}

export function deleteMediaItem(id: number): { deleted: boolean; title: string | null } {
  const item = db.prepare('SELECT title FROM media_items WHERE id = ?').get(id) as { title: string } | undefined
  if (!item) return { deleted: false, title: null }
  db.prepare('DELETE FROM media_items WHERE id = ?').run(id)
  return { deleted: true, title: item.title }
}

export function findMediaItemByTitleYear(title: string, year: number | null): MediaItem | undefined {
  if (year != null) {
    return (
      db.prepare('SELECT * FROM media_items WHERE LOWER(title) = LOWER(?) AND year = ?').get(title, year) as MediaItem | undefined
      ?? db.prepare('SELECT * FROM media_items WHERE LOWER(title) = LOWER(?) AND year IS NULL').get(title) as MediaItem | undefined
    )
  }
  return db.prepare('SELECT * FROM media_items WHERE LOWER(title) = LOWER(?)').get(title) as MediaItem | undefined
}

export function findMediaItemByTmdbId(tmdbId: number): MediaItem | undefined {
  return db.prepare('SELECT * FROM media_items WHERE tmdb_id = ?').get(tmdbId) as MediaItem | undefined
}

export function listItemsNeedingEnrichment(): MediaItem[] {
  return db.prepare('SELECT * FROM media_items WHERE poster_url IS NULL AND needs_review = 0 ORDER BY id').all() as MediaItem[]
}

// --- Users ---

function generateUserKey(name: string): string {
  const base = name.toLowerCase()
    .replace(/[áà]/g, 'a').replace(/[éè]/g, 'e').replace(/[íì]/g, 'i')
    .replace(/[óòöő]/g, 'o').replace(/[úùüű]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'user'
  let candidate = base
  let n = 2
  while (db.prepare('SELECT 1 FROM media_users WHERE key = ?').get(candidate)) {
    candidate = `${base}-${n++}`
  }
  return candidate
}

export function listMediaUsers(): MediaUser[] {
  return db.prepare('SELECT * FROM media_users ORDER BY is_admin DESC, id').all() as MediaUser[]
}

export function getMediaUserByKey(key: string): MediaUser | undefined {
  return db.prepare('SELECT * FROM media_users WHERE key = ?').get(key) as MediaUser | undefined
}

export function getMediaUserById(id: number): MediaUser | undefined {
  return db.prepare('SELECT * FROM media_users WHERE id = ?').get(id) as MediaUser | undefined
}

export function createMediaUser(name: string, color: string, avatar?: string | null, isAdmin = false, tasteProfile?: string | null): MediaUser {
  const key = generateUserKey(name)
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    'INSERT INTO media_users (key, name, color, avatar, is_admin, taste_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(key, name, color, avatar ?? null, isAdmin ? 1 : 0, tasteProfile ?? null, now)
  return db.prepare('SELECT * FROM media_users WHERE id = ?').get(result.lastInsertRowid) as MediaUser
}

export function updateMediaUser(id: number, data: { name?: string; color?: string; avatar?: string | null; tasteProfile?: string | null }): MediaUser | undefined {
  const user = db.prepare('SELECT * FROM media_users WHERE id = ?').get(id) as MediaUser | undefined
  if (!user) return undefined
  const newName  = data.name   !== undefined ? data.name   : user.name
  const newColor = data.color  !== undefined ? data.color  : user.color
  const newAvatar = data.avatar !== undefined ? data.avatar : user.avatar
  const newTaste  = data.tasteProfile !== undefined ? data.tasteProfile : user.taste_profile
  db.prepare('UPDATE media_users SET name = ?, color = ?, avatar = ?, taste_profile = ? WHERE id = ?').run(newName, newColor, newAvatar, newTaste, id)
  return db.prepare('SELECT * FROM media_users WHERE id = ?').get(id) as MediaUser
}

export function hasAnyUsers(): boolean {
  return (db.prepare('SELECT COUNT(*) as c FROM media_users').get() as { c: number }).c > 0
}

// --- Per-user status ---

export function getAllMediaUserStatuses(): Record<number, Record<number, { state: string; score: number | null }>> {
  const rows = db.prepare('SELECT media_id, user_id, state, score FROM media_user_status').all() as {
    media_id: number; user_id: number; state: string; score: number | null
  }[]
  const out: Record<number, Record<number, { state: string; score: number | null }>> = {}
  for (const row of rows) {
    if (!out[row.media_id]) out[row.media_id] = {}
    out[row.media_id][row.user_id] = { state: row.state, score: row.score }
  }
  return out
}

export function upsertMediaUserStatus(mediaId: number, userId: number, data: { state?: string; score?: number | null }): void {
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    const existing = db.prepare('SELECT id, state, score FROM media_user_status WHERE media_id = ? AND user_id = ?')
      .get(mediaId, userId) as { id: number; state: string; score: number | null } | undefined
    const newState = data.state ?? existing?.state ?? 'none'
    const newScore = data.score !== undefined ? data.score : (existing?.score ?? null)
    if (existing) {
      db.prepare('UPDATE media_user_status SET state = ?, score = ?, updated_at = ? WHERE id = ?')
        .run(newState, newScore, now, existing.id)
    } else {
      db.prepare('INSERT INTO media_user_status (media_id, user_id, state, score, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(mediaId, userId, newState, newScore, now)
    }
  })()
}

// --- Recommendations ---

export function listMediaRecommendations(audience?: string): MediaRecommendation[] {
  const audienceClause = audience ? 'AND r.audience = ?' : ''
  const params: unknown[] = audience ? [audience] : []
  return db.prepare(`
    SELECT r.* FROM media_recommendations r
    WHERE NOT EXISTS (
      SELECT 1 FROM media_items m
      WHERE m.type = r.type AND LOWER(m.title) = LOWER(r.title)
    )
    ${audienceClause}
    ORDER BY r.audience, r.id DESC
  `).all(...params) as MediaRecommendation[]
}

export function replaceMediaRecommendations(
  audience: string,
  items: Array<Pick<MediaRecommendation, 'type' | 'title'> & Partial<Pick<MediaRecommendation, 'year' | 'reason' | 'poster_url' | 'overview' | 'source'>>>
): number {
  const now = Math.floor(Date.now() / 1000)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM media_recommendations WHERE audience = ?').run(audience)
    const stmt = db.prepare(`
      INSERT INTO media_recommendations (type, title, year, reason, poster_url, overview, source, audience, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of items) {
      stmt.run(item.type, item.title, item.year ?? null, item.reason ?? null,
               item.poster_url ?? null, item.overview ?? null, item.source ?? 'ai', audience, now)
    }
    return items.length
  })
  return tx() as number
}

export function getMediaRecommendationById(id: number): MediaRecommendation | undefined {
  return db.prepare('SELECT * FROM media_recommendations WHERE id = ?').get(id) as MediaRecommendation | undefined
}

// --- Recommendation queries ---

export function getInternalRecommendations(userId: number): RecRow[] {
  return db.prepare(`
    SELECT
      mi.id, mi.type, mi.title, mi.year, mi.poster_url, mi.overview,
      mi.tmdb_id, mi.runtime, mi.genres, mi."cast",
      mu.name AS liker_name, mu.id AS liker_user_id, mus.score AS liker_score
    FROM media_items mi
    JOIN media_user_status mus ON mus.media_id = mi.id
    JOIN media_users mu ON mu.id = mus.user_id
    WHERE mus.user_id != ?
      AND mus.state = 'seen'
      AND mus.score >= 7
      AND mi.needs_review = 0
      AND mi.id NOT IN (
        SELECT media_id FROM media_user_status
        WHERE user_id = ? AND state IN ('seen', 'not_interested')
      )
    ORDER BY mus.score DESC, mi.title COLLATE NOCASE
  `).all(userId, userId) as RecRow[]
}

export function getExternalRecsForUser(userKey: string, userId: number): MediaRecommendation[] {
  return db.prepare(`
    SELECT mr.* FROM media_recommendations mr
    WHERE mr.audience = ?
      AND LOWER(mr.title) NOT IN (
        SELECT LOWER(mi.title) FROM media_items mi
        JOIN media_user_status mus ON mus.media_id = mi.id
        WHERE mus.user_id = ? AND mus.state != 'none'
      )
    ORDER BY mr.id DESC
  `).all(userKey, userId) as MediaRecommendation[]
}

export function getExternalRecsForGroup(groupKeys: string[], groupUserIds: number[]): MediaRecommendation[] {
  if (!groupKeys.length || !groupUserIds.length) return []
  const keyPh = [...groupKeys, 'kozos'].map(() => '?').join(',')
  const idPh  = groupUserIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT DISTINCT mr.* FROM media_recommendations mr
    WHERE mr.audience IN (${keyPh})
      AND LOWER(mr.title) NOT IN (
        SELECT LOWER(mi.title) FROM media_items mi
        JOIN media_user_status mus ON mus.media_id = mi.id
        WHERE mus.user_id IN (${idPh}) AND mus.state IN ('seen', 'not_interested')
      )
    ORDER BY mr.id DESC
  `).all(...groupKeys, 'kozos', ...groupUserIds) as MediaRecommendation[]
}

export function getGroupWatchlistItems(groupUserIds: number[]): WatchlistRow[] {
  if (!groupUserIds.length) return []
  const ph = groupUserIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT
      mi.id, mi.type, mi.title, mi.year, mi.poster_url, mi.overview,
      mi.tmdb_id, mi.runtime, mi.genres, mi."cast",
      mu.name AS watcher_name, mu.id AS watcher_user_id
    FROM media_items mi
    JOIN media_user_status mus_w ON mus_w.media_id = mi.id
    JOIN media_users mu ON mu.id = mus_w.user_id
    WHERE mus_w.user_id IN (${ph})
      AND mus_w.state = 'watchlist'
      AND mi.needs_review = 0
      AND mi.id NOT IN (
        SELECT media_id FROM media_user_status
        WHERE user_id IN (${ph}) AND state IN ('seen', 'not_interested')
      )
    ORDER BY mi.title COLLATE NOCASE
  `).all(...groupUserIds, ...groupUserIds) as WatchlistRow[]
}

export function getGroupRecommendations(groupUserIds: number[]): RecRow[] {
  if (!groupUserIds.length) return []
  const ph = groupUserIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT
      mi.id, mi.type, mi.title, mi.year, mi.poster_url, mi.overview,
      mi.tmdb_id, mi.runtime, mi.genres, mi."cast",
      mu.name AS liker_name, mu.id AS liker_user_id, mus_liker.score AS liker_score
    FROM media_items mi
    JOIN media_user_status mus_liker ON mus_liker.media_id = mi.id
    JOIN media_users mu ON mu.id = mus_liker.user_id
    WHERE mus_liker.state = 'seen'
      AND mus_liker.score >= 7
      AND mi.needs_review = 0
      AND mi.id NOT IN (
        SELECT media_id FROM media_user_status
        WHERE user_id IN (${ph}) AND state IN ('seen', 'not_interested')
      )
    ORDER BY mus_liker.score DESC, mi.title COLLATE NOCASE
  `).all(...groupUserIds) as RecRow[]
}

export interface UserStats {
  seen: number
  watchlist: number
  in_progress: number
  not_interested: number
  avg_score: number | null
  total_runtime_min: number | null
  top_genres: Array<{ name: string; count: number }>
  score_dist: Array<{ score: number; count: number }>
}

export function getUserStats(userId: number): UserStats {
  const counts = db.prepare(
    'SELECT state, COUNT(*) as cnt FROM media_user_status WHERE user_id = ? GROUP BY state'
  ).all(userId) as Array<{ state: string; cnt: number }>
  const stateMap = Object.fromEntries(counts.map(r => [r.state, r.cnt]))

  const avgRow = db.prepare(
    'SELECT AVG(CAST(score AS REAL)) as avg FROM media_user_status WHERE user_id = ? AND score IS NOT NULL AND state = \'seen\''
  ).get(userId) as { avg: number | null }

  const runtimeRow = db.prepare(`
    SELECT SUM(mi.runtime) as total
    FROM media_user_status mus
    JOIN media_items mi ON mi.id = mus.media_id
    WHERE mus.user_id = ? AND mus.state = 'seen' AND mi.type = 'film' AND mi.runtime IS NOT NULL
  `).get(userId) as { total: number | null }

  const genreRows = db.prepare(`
    SELECT mi.genres FROM media_user_status mus
    JOIN media_items mi ON mi.id = mus.media_id
    WHERE mus.user_id = ? AND mus.state = 'seen' AND mi.genres IS NOT NULL
  `).all(userId) as Array<{ genres: string }>
  const genreCount: Record<string, number> = {}
  for (const row of genreRows) {
    try {
      const parsed = JSON.parse(row.genres) as Array<{ name?: string } | string>
      for (const g of parsed) {
        const name = typeof g === 'string' ? g : (g.name ?? '')
        if (name) genreCount[name] = (genreCount[name] ?? 0) + 1
      }
    } catch { /* skip */ }
  }
  const top_genres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, count]) => ({ name, count }))

  const scoreDist = db.prepare(
    'SELECT score, COUNT(*) as cnt FROM media_user_status WHERE user_id = ? AND score IS NOT NULL GROUP BY score ORDER BY score'
  ).all(userId) as Array<{ score: number; cnt: number }>

  return {
    seen: stateMap['seen'] ?? 0,
    watchlist: stateMap['watchlist'] ?? 0,
    in_progress: stateMap['in_progress'] ?? 0,
    not_interested: stateMap['not_interested'] ?? 0,
    avg_score: avgRow.avg != null ? Math.round(avgRow.avg * 10) / 10 : null,
    total_runtime_min: runtimeRow.total ?? null,
    top_genres,
    score_dist: scoreDist.map(r => ({ score: r.score, count: r.cnt })),
  }
}

export function getUserSeenProfile(userId: number): Array<{ title: string; genres: string | null; score: number }> {
  return db.prepare(`
    SELECT mi.title, mi.genres, mus.score
    FROM media_user_status mus
    JOIN media_items mi ON mi.id = mus.media_id
    WHERE mus.user_id = ? AND mus.state = 'seen' AND mus.score IS NOT NULL
    ORDER BY mus.score DESC
  `).all(userId) as Array<{ title: string; genres: string | null; score: number }>
}

export function getUserExcludedTitles(userId: number, audienceKey: string): string[] {
  return (db.prepare(`
    SELECT LOWER(mi.title) as t
    FROM media_user_status mus
    JOIN media_items mi ON mi.id = mus.media_id
    WHERE mus.user_id = ? AND mus.state != 'none'
    UNION
    SELECT LOWER(title) as t FROM media_recommendations WHERE audience = ?
  `).all(userId, audienceKey) as Array<{ t: string }>).map(r => r.t)
}
