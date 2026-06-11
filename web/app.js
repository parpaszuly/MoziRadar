/* MoziRadar — Wave 3: per-user state editing + triage */
'use strict'

// ── State ──────────────────────────────────────────────────────────────────
let activeUser = null       // {id, key, name, color, is_admin}
let usersCache = []         // all users from API
let catalogItems = []       // normalized flat array
let statusMap = {}          // string(media_id) -> string(user_id) -> {state, score}
let searchQuery = ''
let activeTab = 'home'
let triageMode = false
let selectedItems = new Set()
let openDetailId = null   // media_id of currently open detail modal (null = closed)
let recPersonalData = null  // cached GET /api/recommend response
let ajanlokEditorRows = [] // mutable rows for the recommendation editor
let pendingSeenId = null   // card with open inline score picker on the 'none' tab
const extRecCache = new Map()  // recId -> item object for external rec popup

// ── Utils ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function avatarInitials(name) {
  return String(name).trim().slice(0, 2).toUpperCase()
}

function showToast(msg, ms = 2800) {
  const el = document.getElementById('moziToast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(el._timer)
  el._timer = setTimeout(() => el.classList.remove('show'), ms)
}

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

function normalizeCatalog(data) {
  if (Array.isArray(data.items)) return data.items
  const films = (data.films || []).map(f => ({ ...f, type: f.type || 'film' }))
  const series = (data.series || []).map(s => ({ ...s, type: s.type || 'series' }))
  return [...films, ...series]
}

// ── Page routing ───────────────────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.mozi-page').forEach(p => p.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

// ── Profile picker ─────────────────────────────────────────────────────────
function renderProfileGridFromCache() {
  const grid = document.getElementById('profilesGrid')
  if (!grid) return
  if (!usersCache.length) {
    grid.innerHTML = '<div class="mozi-empty">Nincs elérhető profil.</div>'
    return
  }
  grid.innerHTML = usersCache.map(u => {
    const initials = escapeHtml(avatarInitials(u.name))
    const name = escapeHtml(u.name)
    const color = escapeHtml(u.color || '#888')
    const safeId = escapeHtml(String(u.id))
    return `<div class="mozi-profile-card" data-user-id="${safeId}" onclick="selectUser(${u.id})">
      <div class="mozi-avatar-lg" style="background:${color}">${initials}</div>
      <div class="mozi-profile-name">${name}</div>
    </div>`
  }).join('')
}

async function loadProfiles() {
  const grid = document.getElementById('profilesGrid')
  try {
    const data = await apiFetch('/api/users')
    usersCache = data.users || []
    renderProfileGridFromCache()
  } catch (err) {
    grid.innerHTML = `<div class="mozi-error">Profilok nem tölthetők be: ${escapeHtml(err.message)}</div>`
  }
}

function selectUser(userId) {
  const user = usersCache.find(u => u.id === userId)
  if (!user) return
  activeUser = { id: user.id, key: user.key, name: user.name, color: user.color || '#888', is_admin: user.is_admin }
  recPersonalData = null
  localStorage.setItem('mozi_active_user', JSON.stringify(activeUser))
  updateHeader()
  openLibrary()
}

function restoreUser() {
  try {
    const stored = localStorage.getItem('mozi_active_user')
    if (stored) activeUser = JSON.parse(stored)
  } catch (_) { activeUser = null }
}

// ── Header ─────────────────────────────────────────────────────────────────
function updateHeader() {
  const headerUser = document.getElementById('headerUser')
  if (!activeUser) { headerUser.hidden = true; return }
  headerUser.hidden = false
  const avatarEl = document.getElementById('headerAvatar')
  avatarEl.textContent = avatarInitials(activeUser.name)
  avatarEl.style.background = activeUser.color || '#888'
  document.getElementById('headerName').textContent = activeUser.name
  const adminBtn = document.getElementById('headerAdminBtn')
  if (adminBtn) adminBtn.hidden = !activeUser.is_admin
}

// ── Library ────────────────────────────────────────────────────────────────
async function openLibrary() {
  showPage('pageLibrary')
  document.getElementById('catalogGrid').innerHTML = '<div class="mozi-loading">Betöltés...</div>'
  try {
    const [catalogData, statusData] = await Promise.all([
      apiFetch('/api/catalog'),
      apiFetch('/api/status'),
    ])
    catalogItems = normalizeCatalog(catalogData)
    statusMap = statusData.statuses || {}
  } catch (err) {
    document.getElementById('catalogGrid').innerHTML =
      `<div class="mozi-error">Könyvtár nem töltött be: ${escapeHtml(err.message)}</div>`
    return
  }
  renderCatalog()
}

async function refreshStatus() {
  try {
    const data = await apiFetch('/api/status')
    statusMap = data.statuses || {}
  } catch (_) {}
}

// ── Status helpers ─────────────────────────────────────────────────────────
const STATES = [
  { key: 'seen',           label: 'Láttam',      short: 'Láttam',      cls: 'seen' },
  { key: 'watchlist',      label: 'Megnézném',   short: 'Megnézném',   cls: 'watchlist' },
  { key: 'in_progress',    label: 'Folyamatban', short: 'Folyamatban', cls: 'in_progress' },
  { key: 'not_interested', label: 'Nem érdekel', short: 'Nem érdekel', cls: 'not_interested' },
  { key: 'none',           label: 'Nincs',       short: 'Visszaállít', cls: 'none' },
]

function getUserStatus(mediaId, userId) {
  const uid = String(userId ?? activeUser?.id)
  return (statusMap[String(mediaId)] || {})[uid] || { state: 'none', score: null }
}

function calcAvgScore(mediaId) {
  const byMedia = statusMap[String(mediaId)] || {}
  const scores = Object.values(byMedia)
    .filter(s => s.state === 'seen' && s.score != null)
    .map(s => s.score)
  if (scores.length < 2) return null
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
}

// ── Optimistic state update ────────────────────────────────────────────────
async function moziSetState(mediaId, state, score, opts = {}) {
  if (!activeUser) return
  const mid = String(mediaId)
  const uid = String(activeUser.id)
  const prev = getUserStatus(mediaId)

  // Optimistic update
  statusMap[mid] = statusMap[mid] || {}
  statusMap[mid][uid] = { state, score: state === 'seen' ? (score ?? prev.score) : null }
  if (!opts.batchRender) renderCatalog()
  refreshDetailIfOpen(mediaId)

  try {
    const body = { state }
    if (state === 'seen') body.score = score ?? prev.score ?? null
    const data = await apiFetch(`/api/status/${mediaId}/${activeUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    statusMap[mid][uid] = { state: data.state, score: data.score ?? null }
    if (!opts.batchRender) renderCatalog()
    refreshDetailIfOpen(mediaId)
  } catch (err) {
    statusMap[mid][uid] = prev
    if (!opts.batchRender) renderCatalog()
    refreshDetailIfOpen(mediaId)
    showToast('Hiba: ' + err.message)
  }
}

async function moziSetScore(mediaId, score) {
  await moziSetState(mediaId, 'seen', score)
}

// ── Triage / bulk ──────────────────────────────────────────────────────────
function enterTriageMode() {
  triageMode = true
  selectedItems.clear()
  updateTriageBar()
  renderCatalog()
}

function exitTriageMode() {
  triageMode = false
  selectedItems.clear()
  updateTriageBar()
  renderCatalog()
}

function toggleTriageSelect(mediaId) {
  if (selectedItems.has(mediaId)) selectedItems.delete(mediaId)
  else selectedItems.add(mediaId)
  const isSelected = selectedItems.has(mediaId)
  updateTriageBar()
  // Update card and checkbox visually without full re-render
  const card = document.querySelector(`.mozi-card[data-id="${CSS.escape(String(mediaId))}"]`)
  if (card) {
    card.classList.toggle('mozi-card--selected', isSelected)
    const cb = card.querySelector('.mozi-triage-cb')
    if (cb) cb.classList.toggle('checked', isSelected)
  }
}

function updateTriageBar() {
  const bar = document.getElementById('moziTriageBar')
  const triageBtn = document.getElementById('moziTriageToggle')
  const hasSelection = triageMode && selectedItems.size > 0
  bar.hidden = !hasSelection
  document.body.classList.toggle('triage-active', hasSelection)
  if (triageBtn) triageBtn.textContent = triageMode ? 'Mégse' : 'Kijelölés'
  if (triageMode) {
    document.getElementById('moziTriageCount').textContent = selectedItems.size + ' kijelölve'
  }
}

async function moziApplyBulkState(state) {
  if (!selectedItems.size) return
  const ids = [...selectedItems]
  const userId = String(activeUser.id)  // rögzítve call time-ban, profilváltás-safe
  // Optimistic all at once
  ids.forEach(id => {
    const mid = String(id)
    statusMap[mid] = statusMap[mid] || {}
    statusMap[mid][userId] = { state, score: null }
  })
  selectedItems.clear()
  triageMode = false
  updateTriageBar()
  renderCatalog()
  // Fire PATCH requests in parallel
  const results = await Promise.allSettled(ids.map(id =>
    apiFetch(`/api/status/${id}/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
  ))
  const failed = results.filter(r => r.status === 'rejected').length
  if (failed) {
    showToast(`${failed} mentés sikertelen -- frissítés...`)
    await refreshStatus()
    renderCatalog()
  } else {
    showToast(`${ids.length} tétel: ${STATES.find(s => s.key === state)?.label || state}`)
    // Sync server-returned values
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        const d = r.value
        const mid = String(ids[i])
        statusMap[mid] = statusMap[mid] || {}
        statusMap[mid][userId] = { state: d.state, score: d.score ?? null }
      }
    })
    renderCatalog()
  }
}

// ── Filtering ──────────────────────────────────────────────────────────────
function filterItems() {
  let items = catalogItems
  if (searchQuery) {
    const q = searchQuery
    items = items.filter(i => String(i.title || '').toLowerCase().includes(q))
  }
  if (activeTab === 'home') {
    items = items.filter(i => { const s = getUserStatus(i.id).state; return s === 'watchlist' || s === 'none' || s === 'in_progress' })
  } else if (activeTab === 'film') {
    items = items.filter(i => getUserStatus(i.id).state === 'seen' && (i.type || 'film') === 'film')
  } else if (activeTab === 'series') {
    items = items.filter(i => getUserStatus(i.id).state === 'seen' && i.type === 'series')
  } else if (activeTab === 'none') {
    items = items.filter(i => getUserStatus(i.id).state === 'none')
  } else if (activeTab === 'watchlist') {
    items = items.filter(i => getUserStatus(i.id).state === 'watchlist')
  } else if (activeTab === 'not_interested') {
    items = items.filter(i => getUserStatus(i.id).state === 'not_interested')
  }
  return items
}

// ── Card rendering ─────────────────────────────────────────────────────────
function renderStateBtns(mediaId, currentState, opts = {}) {
  return '<div class="mozi-state-btns">' + STATES.map(s => {
    const active = s.key === currentState ? ' active' : ''
    // On 'none' and 'home' tabs (single-card), intercept 'seen' to show inline score picker first
    const intercept = s.key === 'seen' && (activeTab === 'none' || activeTab === 'home') && !triageMode && !opts.inDetail
    const onclick = intercept
      ? `event.stopPropagation();moziShowScorePicker(${mediaId})`
      : `event.stopPropagation();moziSetState(${mediaId},'${s.key}')`
    return `<button class="mozi-state-btn mozi-state-btn--${s.cls}${active}"
      title="${escapeHtml(s.label)}"
      onclick="${onclick}"
      >${escapeHtml(s.short)}</button>`
  }).join('') + '</div>'
}

function renderScoreRow(mediaId, currentScore) {
  const cur = currentScore ?? 0
  return '<div class="mozi-score-row">' + [1,2,3,4,5,6,7,8,9,10].map(i =>
    `<button class="mozi-score-btn${i <= cur ? ' active' : ''}"
      onclick="event.stopPropagation();moziSetScore(${mediaId},${i})"
      title="${i}/10">${i}</button>`
  ).join('') + '</div>'
}

function renderInlineScorePicker(mediaId) {
  const scores = [1,2,3,4,5,6,7,8,9,10].map(i =>
    `<button class="mozi-score-btn" onclick="event.stopPropagation();moziConfirmSeen(${mediaId},${i})" title="${i}/10">${i}</button>`
  ).join('')
  return `<div class="mozi-inline-score-picker">
    <div class="mozi-inline-score-label">Pont:</div>
    <div class="mozi-score-row">${scores}</div>
    <button class="mozi-inline-score-cancel" onclick="event.stopPropagation();moziCancelScorePicker()">Mégse</button>
  </div>`
}

function moziShowScorePicker(mediaId) {
  pendingSeenId = mediaId
  const card = document.querySelector(`.mozi-card[data-id="${CSS.escape(String(mediaId))}"]`)
  if (!card) return
  const btnArea = card.querySelector('.mozi-state-btns')
  if (!btnArea) return
  const frag = document.createRange().createContextualFragment(renderInlineScorePicker(mediaId))
  btnArea.replaceWith(frag)
}

async function moziConfirmSeen(mediaId, score) {
  pendingSeenId = null
  await moziSetState(mediaId, 'seen', score)
}

function moziCancelScorePicker() {
  pendingSeenId = null
  renderCatalog()
}

function renderOtherUsers(mediaId) {
  if (!usersCache.length) return ''
  const others = usersCache.filter(u => u.id !== activeUser?.id)
  if (!others.length) return ''
  const dots = others.map(u => {
    const { state, score } = getUserStatus(mediaId, u.id)
    const color = escapeHtml(u.color || '#888')
    const initials = escapeHtml(avatarInitials(u.name))
    const stateLabel = STATES.find(s => s.key === state)?.label || 'Nincs'
    const scoreStr = state === 'seen' && score != null ? ` ${score}` : ''
    return `<span class="mozi-user-dot" style="background:${color}" title="${escapeHtml(u.name)}: ${escapeHtml(stateLabel)}${escapeHtml(scoreStr)}">${initials}</span>`
  }).join('')

  const avg = calcAvgScore(mediaId)
  const avgHtml = avg != null ? `<span class="mozi-avg-score" title="Átlag">⌀${avg}</span>` : ''

  return `<div class="mozi-users-row">${dots}${avgHtml}</div>`
}

function renderCard(item) {
  const id = item.id
  const safeId = escapeHtml(String(id))
  const title = escapeHtml(String(item.title || ''))
  const year = item.year ? escapeHtml(String(item.year)) : ''
  const { state, score } = getUserStatus(id)

  const poster = item.poster_url
    ? `<img class="mozi-card-poster" src="${escapeHtml(item.poster_url)}" alt="${title}" loading="lazy">`
    : `<div class="mozi-card-poster-placeholder">${item.type === 'series' ? '📺' : '🎬'}</div>`

  const yearHtml = year ? `<div class="mozi-card-year">${year}</div>` : ''
  const otherUsersHtml = renderOtherUsers(id)
  const stateBtns = renderStateBtns(id, state)
  const scoreRow = state === 'seen' ? renderScoreRow(id, score) : ''

  const isSelected = selectedItems.has(id)
  const checkboxHtml = triageMode
    ? `<div class="mozi-triage-overlay" onclick="event.stopPropagation();toggleTriageSelect(${id})">
         <div class="mozi-triage-cb ${isSelected ? 'checked' : ''}"></div>
       </div>`
    : ''

  return `<div class="mozi-card${isSelected ? ' mozi-card--selected' : ''}" data-id="${safeId}"
    onclick="${triageMode ? `toggleTriageSelect(${id})` : `moziOpenDetail(${id})`}">
    ${checkboxHtml}
    ${poster}
    <div class="mozi-card-body">
      <div class="mozi-card-title">${title}</div>
      ${yearHtml}
      ${otherUsersHtml}
      ${stateBtns}
      ${scoreRow}
    </div>
  </div>`
}

// ── Detail modal ───────────────────────────────────────────────────────────
function parseListField(val) {
  // Handles both comma-string and JSON array (future-proof)
  if (!val) return []
  if (Array.isArray(val)) return val.map(String)
  try { const p = JSON.parse(val); if (Array.isArray(p)) return p.map(String) } catch (_) {}
  return String(val).split(',').map(s => s.trim()).filter(Boolean)
}

function renderAllOpinions(mediaId) {
  if (!usersCache.length) return ''
  const rows = usersCache.map(u => {
    const { state, score } = getUserStatus(mediaId, u.id)
    const si = STATES.find(s => s.key === state) || STATES[4]
    const scoreStr = state === 'seen' && score != null ? ` ${score}/10` : ''
    const color = escapeHtml(u.color || '#888')
    const initials = escapeHtml(avatarInitials(u.name))
    const isActive = activeUser && u.id === activeUser.id
    return `<div class="mozi-opinion-row${isActive ? ' mozi-opinion-row--active' : ''}">
      <span class="mozi-user-dot" style="background:${color}">${initials}</span>
      <span class="mozi-opinion-name">${escapeHtml(u.name)}</span>
      <span class="mozi-opinion-state mozi-opinion--${escapeHtml(si.cls)}">${escapeHtml(si.label)}${escapeHtml(scoreStr)}</span>
    </div>`
  }).join('')
  const avg = calcAvgScore(mediaId)
  const avgHtml = avg != null
    ? `<div class="mozi-opinion-avg">Átlag: <strong>⌀${avg}</strong></div>`
    : ''
  return `<div class="mozi-detail-opinions">${rows}${avgHtml}</div>`
}

function renderDetailStatePicker(mediaId) {
  const { state, score } = getUserStatus(mediaId)
  const btns = renderStateBtns(mediaId, state, { inDetail: true })
  const scoreRow = state === 'seen' ? renderScoreRow(mediaId, score) : ''
  return `<div class="mozi-detail-picker">
    <div class="mozi-detail-picker-label">A te véleményed</div>
    ${btns}${scoreRow}
  </div>`
}

function renderDetailBody(item) {
  const title = escapeHtml(String(item.title || ''))
  const year = item.year ? ` (${escapeHtml(String(item.year))})` : ''
  const runtime = item.runtime ? `${escapeHtml(String(item.runtime))} perc` : ''
  const genres = parseListField(item.genres).map(escapeHtml).join(', ')
  const cast = parseListField(item.cast).map(escapeHtml).join(', ')
  const overview = escapeHtml(String(item.overview || ''))

  const poster = item.poster_url
    ? `<img class="mozi-detail-poster" src="${escapeHtml(item.poster_url)}" alt="${title}">`
    : `<div class="mozi-detail-poster-placeholder">${item.type === 'series' ? '📺' : '🎬'}</div>`

  const metaParts = [runtime, genres].filter(Boolean)
  const metaHtml = metaParts.length
    ? `<div class="mozi-detail-meta">${metaParts.join(' · ')}</div>`
    : ''

  const overviewHtml = overview
    ? `<p class="mozi-detail-overview">${overview}</p>`
    : ''
  const castHtml = cast
    ? `<div class="mozi-detail-cast"><span class="mozi-detail-cast-label">Szereplők:</span> ${cast}</div>`
    : ''

  const opinions = renderAllOpinions(item.id)
  const picker = activeUser ? renderDetailStatePicker(item.id) : ''
  const adminDelete = (activeUser && activeUser.is_admin)
    ? `<div class="mozi-detail-admin">
         <button class="mozi-btn-ghost" onclick="moziAdminOpenEdit(${item.id})">Szerkesztés</button>
         <button class="mozi-btn-ghost" id="adminRematchBtn" onclick="moziAdminRematch(${item.id})">TMDB rematch</button>
         <button class="mozi-btn-delete" onclick="moziAdminDelete(${item.id})">Törlés</button>
       </div>`
    : ''

  return `<div class="mozi-detail-layout">
    <div class="mozi-detail-poster-wrap">${poster}</div>
    <div class="mozi-detail-info">
      <h2 class="mozi-detail-title">${title}${year}</h2>
      ${metaHtml}
      ${overviewHtml}
      ${castHtml}
      <div class="mozi-detail-section-label">Vélemények</div>
      ${opinions}
      ${picker}
      ${adminDelete}
    </div>
  </div>`
}

async function moziAdminDelete(mediaId) {
  if (!activeUser?.is_admin) return
  const item = catalogItems.find(i => i.id === mediaId)
  if (!item) return
  const confirmed = window.confirm(
    `Biztosan törlöd a(z) "${item.title}"-et a listából? Mindenkinél eltűnik, a pontokkal együtt. Nem vonható vissza.`
  )
  if (!confirmed) return
  try {
    await apiFetch(`/api/catalog/${mediaId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: activeUser.id }),
    })
    moziCloseDetail()
    catalogItems = catalogItems.filter(i => i.id !== mediaId)
    delete statusMap[String(mediaId)]
    renderCatalog()
    showToast('Törölve: ' + item.title)
  } catch (err) {
    showToast('Törlés sikertelen: ' + err.message)
  }
}

function moziAdminOpenEdit(mediaId) {
  if (!activeUser?.is_admin) return
  const item = catalogItems.find(i => i.id === mediaId)
  if (!item) return
  const title   = escapeHtml(String(item.title || ''))
  const year    = item.year ? escapeHtml(String(item.year)) : ''
  const poster  = escapeHtml(String(item.poster_url || ''))
  const overview = escapeHtml(String(item.overview || ''))
  document.getElementById('moziDetailBody').innerHTML = `<div class="mozi-admin-edit">
    <h2 class="mozi-useradmin-title">Szerkesztés</h2>
    <div class="mozi-admin-edit-fields">
      <label class="mozi-admin-label">Cím
        <input type="text" id="editTitle" class="mozi-useradmin-name" value="${title}">
      </label>
      <label class="mozi-admin-label">Év
        <input type="number" id="editYear" class="mozi-useradmin-name mozi-input-narrow" value="${year}" min="1900" max="2100">
      </label>
      <label class="mozi-admin-label">Poszter URL
        <input type="url" id="editPoster" class="mozi-useradmin-name" value="${poster}">
      </label>
      <label class="mozi-admin-label">Leírás
        <textarea id="editOverview" class="mozi-admin-textarea">${overview}</textarea>
      </label>
    </div>
    <div class="mozi-admin-edit-actions">
      <button class="mozi-btn-primary" onclick="moziAdminSaveEdit(${mediaId})">Mentés</button>
      <button class="mozi-btn-ghost" onclick="moziOpenDetail(${mediaId})">Mégsem</button>
    </div>
  </div>`
}

async function moziAdminSaveEdit(mediaId) {
  if (!activeUser?.is_admin) return
  const titleVal   = document.getElementById('editTitle')?.value.trim()
  const yearVal    = document.getElementById('editYear')?.value.trim()
  const posterVal  = document.getElementById('editPoster')?.value.trim()
  const overviewVal = document.getElementById('editOverview')?.value.trim()
  if (!titleVal) { showToast('A cím nem lehet üres.'); return }
  const patch = {
    adminId: activeUser.id,
    title: titleVal,
    year: yearVal ? parseInt(yearVal, 10) : null,
    poster_url: posterVal || null,
    overview: overviewVal || null,
  }
  try {
    const data = await apiFetch(`/api/catalog/${mediaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const idx = catalogItems.findIndex(i => i.id === mediaId)
    if (idx >= 0) {
      if (data.item) catalogItems[idx] = { ...catalogItems[idx], ...data.item }
      else Object.assign(catalogItems[idx], { title: patch.title, year: patch.year, poster_url: patch.poster_url, overview: patch.overview })
    }
    renderCatalog()
    moziOpenDetail(mediaId)
    showToast('Mentve.')
  } catch (err) { showToast('Hiba: ' + err.message) }
}

async function moziAdminRematch(mediaId) {
  if (!activeUser?.is_admin) return
  const btn = document.getElementById('adminRematchBtn')
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const data = await apiFetch(`/api/catalog/${mediaId}/rematch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id }),
    })
    if (data.ok) {
      // Re-fetch full catalog: data.after only has {tmdb_id, year, poster_url},
      // but backend also updates cast, genres, runtime, overview.
      const catalogData = await apiFetch('/api/catalog')
      catalogItems = normalizeCatalog(catalogData)
      renderCatalog()
      moziOpenDetail(mediaId)
      showToast('TMDB rematch kész.')
    } else {
      showToast('Rematch: ' + (data.message || 'nem sikerült'))
      if (btn) { btn.disabled = false; btn.textContent = 'TMDB rematch' }
    }
  } catch (err) {
    showToast('Hiba: ' + err.message)
    if (btn) { btn.disabled = false; btn.textContent = 'TMDB rematch' }
  }
}

function moziOpenDetail(mediaId) {
  if (triageMode) return
  const item = catalogItems.find(i => i.id === mediaId)
  if (!item) return
  openDetailId = mediaId
  const overlay = document.getElementById('moziDetailOverlay')
  document.getElementById('moziDetailBody').innerHTML = renderDetailBody(item)
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}

function moziCloseDetail() {
  openDetailId = null
  document.getElementById('moziDetailOverlay').classList.remove('active')
  document.body.style.overflow = ''
}

function refreshDetailIfOpen(mediaId) {
  if (openDetailId !== mediaId) return
  const item = catalogItems.find(i => i.id === mediaId)
  if (!item) return
  document.getElementById('moziDetailBody').innerHTML = renderDetailBody(item)
}

// ── Admin panel (tabbed: Felhasználók / Katalógus / Ajánló) ────────────────
function openUserAdmin() {
  document.getElementById('moziUserAdminBody').innerHTML = renderAdminPanel('felhasznalok')
  document.getElementById('moziUserAdminOverlay').classList.add('active')
  document.body.style.overflow = 'hidden'
}

function renderAdminPanel(tab) {
  const tabs = [
    { id: 'felhasznalok', label: 'Felhasználók' },
    { id: 'katalogus',    label: 'Katalógus' },
    { id: 'ajanlok',      label: 'Ajánló' },
  ]
  const tabsHtml = tabs.map(t =>
    `<button class="mozi-admin-tab${t.id === tab ? ' active' : ''}" data-tab="${t.id}" onclick="switchAdminTab('${t.id}')">${t.label}</button>`
  ).join('')
  const content = tab === 'felhasznalok' ? renderUserAdminBody() :
                  tab === 'katalogus'    ? renderKatalogTab() :
                  renderAjanlokTab()
  return `<div class="mozi-admin-panel">
    <h2 class="mozi-useradmin-title">Admin</h2>
    <div class="mozi-admin-tabs">${tabsHtml}</div>
    <div id="adminContent">${content}</div>
  </div>`
}

function switchAdminTab(tab) {
  document.querySelectorAll('.mozi-admin-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab))
  const el = document.getElementById('adminContent')
  if (!el) return
  el.innerHTML = tab === 'felhasznalok' ? renderUserAdminBody() :
                 tab === 'katalogus'    ? renderKatalogTab() :
                 renderAjanlokTab()
}

function renderKatalogTab() {
  return `<div class="mozi-admin-section">
    <div class="mozi-block-header">Új cím hozzáadása</div>
    <div class="mozi-admin-row">
      <select id="newItemType" class="mozi-useradmin-name" style="flex:0 0 100px">
        <option value="film">Film</option>
        <option value="series">Sorozat</option>
      </select>
      <input type="text" id="newItemTitle" class="mozi-useradmin-name" placeholder="Cím (TMDB-n keres)">
      <button class="mozi-btn-primary" onclick="addCatalogItem()">Hozzáadás</button>
    </div>
    <div id="addItemResult"></div>
  </div>
  <div class="mozi-admin-section">
    <div class="mozi-block-header">Poszterek</div>
    <p class="mozi-admin-hint">Poszter nélküli tételek TMDB backfill-je.</p>
    <button class="mozi-btn-ghost" id="backfillBtn" onclick="runBackfill()">Poszterek frissítése</button>
    <div id="backfillResult"></div>
  </div>`
}

function renderAjanlokTab() {
  return `<div class="mozi-admin-section">
    <div class="mozi-block-header">Ajánló szerkesztő</div>
    <p class="mozi-admin-hint mozi-admin-warn">Figyelem: a Mentés LECSERÉLI az adott közönség teljes ajánlólistáját.</p>
    <div class="mozi-admin-row" style="margin-bottom:14px">
      <select id="ajanlokAudience" class="mozi-useradmin-name" style="flex:0 0 120px">
        <option value="dani">Dani</option>
        <option value="feleseg">Feleség</option>
        <option value="kozos">Közös</option>
      </select>
      <button class="mozi-btn-ghost" onclick="loadAjanlokEditor()">Betöltés</button>
    </div>
    <div id="ajanlokEditorList"></div>
    <div id="ajanlokEditorActions" hidden>
      <button class="mozi-btn-ghost" onclick="addAjanlokRow()" style="margin-bottom:12px">+ Sor hozzáadása</button>
      <button class="mozi-btn-primary" onclick="saveAjanlokEditor()">Mentés (lista lecserélése)</button>
    </div>
  </div>`
}

async function addCatalogItem() {
  if (!activeUser?.is_admin) return
  const type = document.getElementById('newItemType')?.value || 'film'
  const title = document.getElementById('newItemTitle')?.value.trim()
  if (!title) { showToast('Adj meg egy címet.'); return }
  const resultEl = document.getElementById('addItemResult')
  if (resultEl) resultEl.innerHTML = '<div class="mozi-admin-hint">Hozzáadás...</div>'
  try {
    const data = await apiFetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id, type, title }),
    })
    const item = data.item
    if (item) { catalogItems.push(item); renderCatalog() }
    if (resultEl) resultEl.innerHTML = `<div class="mozi-admin-ok">Hozzáadva: ${escapeHtml(item?.title || title)}</div>`
    const titleEl = document.getElementById('newItemTitle')
    if (titleEl) titleEl.value = ''
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="mozi-admin-err">Hiba: ${escapeHtml(err.message)}</div>`
  }
}

async function runBackfill() {
  if (!activeUser?.is_admin) return
  const btn = document.getElementById('backfillBtn')
  const resultEl = document.getElementById('backfillResult')
  if (btn) { btn.disabled = true; btn.textContent = 'Futtatás...' }
  try {
    const data = await apiFetch('/api/catalog/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id }),
    })
    if (resultEl) resultEl.innerHTML = `<div class="mozi-admin-ok">Frissítve: ${data.updated ?? 0} tétel</div>`
    const catalogData = await apiFetch('/api/catalog')
    catalogItems = normalizeCatalog(catalogData)
    renderCatalog()
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="mozi-admin-err">Hiba: ${escapeHtml(err.message)}</div>`
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Poszterek frissítése' }
  }
}

async function loadAjanlokEditor() {
  const audience = document.getElementById('ajanlokAudience')?.value
  if (!audience) return
  const listEl = document.getElementById('ajanlokEditorList')
  const actionsEl = document.getElementById('ajanlokEditorActions')
  if (!listEl) return
  listEl.innerHTML = '<div class="mozi-loading" style="padding:8px 0">Betöltés...</div>'
  if (actionsEl) actionsEl.hidden = true
  try {
    const data = await apiFetch(`/api/recommendations?audience=${encodeURIComponent(audience)}`)
    const raw = data.items || data.recommendations || (Array.isArray(data) ? data : [])
    ajanlokEditorRows = raw.map(i => ({ title: String(i.title || ''), reason: String(i.reason || '') }))
    renderAjanlokEditorRows()
    if (actionsEl) actionsEl.hidden = false
  } catch (err) {
    listEl.innerHTML = `<div class="mozi-admin-err">Hiba: ${escapeHtml(err.message)}</div>`
  }
}

function renderAjanlokEditorRows() {
  const listEl = document.getElementById('ajanlokEditorList')
  if (!listEl) return
  if (!ajanlokEditorRows.length) {
    listEl.innerHTML = '<div class="mozi-admin-hint" style="padding:8px 0">Üres lista.</div>'
    return
  }
  listEl.innerHTML = ajanlokEditorRows.map((row, i) =>
    `<div class="mozi-ajanlok-editor-row">
      <input type="text" class="mozi-useradmin-name" placeholder="Cím" value="${escapeHtml(row.title)}"
        oninput="ajanlokEditorRows[${i}].title=this.value">
      <input type="text" class="mozi-useradmin-name" placeholder="Miért ajánljuk" value="${escapeHtml(row.reason)}"
        oninput="ajanlokEditorRows[${i}].reason=this.value">
      <button class="mozi-btn-ghost" onclick="removeAjanlokRow(${i})">✕</button>
    </div>`
  ).join('')
}

function addAjanlokRow() {
  ajanlokEditorRows.push({ title: '', reason: '' })
  renderAjanlokEditorRows()
  const rows = document.querySelectorAll('.mozi-ajanlok-editor-row')
  if (rows.length) { const inp = rows[rows.length - 1].querySelector('input'); if (inp) inp.focus() }
}

function removeAjanlokRow(i) {
  ajanlokEditorRows.splice(i, 1)
  renderAjanlokEditorRows()
}

async function saveAjanlokEditor() {
  if (!activeUser?.is_admin) return
  const audience = document.getElementById('ajanlokAudience')?.value
  if (!audience) return
  const items = ajanlokEditorRows.filter(r => r.title.trim())
  const confirmed = window.confirm(
    `Biztosan lecseréled a(z) "${audience}" közönség teljes ajánlólistáját (${items.length} tétel)? Ez visszafordíthatatlan.`
  )
  if (!confirmed) return
  try {
    await apiFetch('/api/recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id, audience, items }),
    })
    recPersonalData = null
    showToast(`${audience}: ${items.length} ajánlás mentve.`)
  } catch (err) {
    showToast('Hiba: ' + err.message)
  }
}

// ── User admin ─────────────────────────────────────────────────────────────

function closeUserAdmin() {
  document.getElementById('moziUserAdminOverlay').classList.remove('active')
  document.body.style.overflow = ''
}

function renderUserAdminBody() {
  const rows = usersCache.map(u => {
    const initials = escapeHtml(avatarInitials(u.name))
    const color = escapeHtml(u.color || '#888')
    const name = escapeHtml(u.name)
    const badge = u.is_admin ? '<span class="mozi-useradmin-badge">admin</span>' : ''
    return `<div class="mozi-useradmin-row" id="useradmin-row-${u.id}">
      <div class="mozi-avatar-sm mozi-useradmin-avatar" id="useradmin-avatar-${u.id}" style="background:${color}">${initials}</div>
      <div class="mozi-useradmin-fields">
        <div class="mozi-useradmin-namewrap">
          <input type="text" class="mozi-useradmin-name" id="useradmin-name-${u.id}" value="${name}" placeholder="Név">
          ${badge}
        </div>
        <input type="color" class="mozi-useradmin-color" id="useradmin-color-${u.id}" value="${color}"
          oninput="updateEditAvatar(${u.id})">
      </div>
      <button class="mozi-btn-ghost mozi-useradmin-save" onclick="saveUserEdit(${u.id})">Mentés</button>
    </div>`
  }).join('')

  return `<div class="mozi-useradmin">
    <h2 class="mozi-useradmin-title">Felhasználók</h2>
    <div class="mozi-useradmin-list">${rows}</div>
    <div class="mozi-useradmin-add">
      <div class="mozi-block-header" style="margin-top:20px">Új felhasználó</div>
      <div class="mozi-useradmin-row">
        <div class="mozi-avatar-sm mozi-useradmin-avatar" id="newUserAvatar" style="background:#6a9bcc">?</div>
        <div class="mozi-useradmin-fields">
          <input type="text" id="newUserName" class="mozi-useradmin-name" placeholder="Név"
            oninput="updateNewAvatar()">
          <input type="color" id="newUserColor" class="mozi-useradmin-color" value="#6a9bcc"
            oninput="updateNewAvatar()">
        </div>
        <button class="mozi-btn-primary" onclick="addUser()">Hozzáadás</button>
      </div>
    </div>
  </div>`
}

function updateEditAvatar(userId) {
  const colorEl = document.getElementById(`useradmin-color-${userId}`)
  const avatarEl = document.getElementById(`useradmin-avatar-${userId}`)
  if (colorEl && avatarEl) avatarEl.style.background = colorEl.value
}

function updateNewAvatar() {
  const colorEl = document.getElementById('newUserColor')
  const nameEl  = document.getElementById('newUserName')
  const avatarEl = document.getElementById('newUserAvatar')
  if (!avatarEl) return
  if (colorEl) avatarEl.style.background = colorEl.value
  const name = nameEl ? nameEl.value.trim() : ''
  avatarEl.textContent = name ? avatarInitials(name) : '?'
}

async function saveUserEdit(userId) {
  if (!activeUser?.is_admin) return
  const nameEl  = document.getElementById(`useradmin-name-${userId}`)
  const colorEl = document.getElementById(`useradmin-color-${userId}`)
  const name  = nameEl?.value.trim()
  const color = colorEl?.value
  if (!name) { showToast('A név nem lehet üres.'); return }
  const btn = document.querySelector(`#useradmin-row-${userId} .mozi-useradmin-save`)
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const data = await apiFetch(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id, name, color }),
    })
    const updated = data.user || { id: userId, name, color }
    const idx = usersCache.findIndex(u => u.id === userId)
    if (idx >= 0) usersCache[idx] = { ...usersCache[idx], name: updated.name, color: updated.color }
    if (activeUser.id === userId) {
      activeUser.name = updated.name
      activeUser.color = updated.color
      localStorage.setItem('mozi_active_user', JSON.stringify(activeUser))
      updateHeader()
    }
    renderProfileGridFromCache()
    if (document.getElementById('pageLibrary').classList.contains('active')) renderCatalog()
    showToast(`${updated.name} mentve.`)
    if (btn) { btn.disabled = false; btn.textContent = 'Mentés' }
  } catch (err) {
    showToast('Hiba: ' + err.message)
    if (btn) { btn.disabled = false; btn.textContent = 'Mentés' }
  }
}

async function addUser() {
  if (!activeUser?.is_admin) return
  const nameEl  = document.getElementById('newUserName')
  const colorEl = document.getElementById('newUserColor')
  const name  = nameEl?.value.trim()
  const color = colorEl?.value || '#6a9bcc'
  if (!name) { showToast('Adj meg egy nevet.'); return }
  const btn = document.querySelector('.mozi-useradmin-add .mozi-btn-primary')
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const data = await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: activeUser.id, name, color }),
    })
    const newUser = data.user
    usersCache.push(newUser)
    renderProfileGridFromCache()
    if (document.getElementById('pageLibrary').classList.contains('active')) renderCatalog()
    showToast(`${newUser.name} hozzáadva.`)
    document.getElementById('moziUserAdminBody').innerHTML = renderAdminPanel('felhasznalok')
  } catch (err) {
    showToast('Hiba: ' + err.message)
    if (btn) { btn.disabled = false; btn.textContent = 'Hozzáadás' }
  }
}

// ── Recommendations ────────────────────────────────────────────────────────
function mergeRecItems(items) {
  items.forEach(item => {
    if (!catalogItems.find(i => i.id === item.id)) catalogItems.push(item)
  })
}

function likedByHtml(likedBy) {
  return (likedBy || []).map(lb => {
    const score = lb.score != null ? ` ${escapeHtml(String(lb.score))}/10` : ''
    return `<span class="mozi-liked-badge">${escapeHtml(String(lb.name))}${score}</span>`
  }).join(' ')
}

// cardFn optional: override per-item renderer (e.g. external rec items that lack media_items.id)
function renderRecBlock(header, items, metaFn, cardFn) {
  const q = searchQuery
  const filtered = q ? items.filter(i => String(i.title || '').toLowerCase().includes(q)) : items
  if (!filtered.length) return ''
  const renderer = cardFn || renderCard
  const cards = filtered.map(item => {
    const meta = metaFn ? metaFn(item) : null
    if (meta) return `<div class="mozi-rec-item">${renderer(item)}<div class="mozi-rec-meta">${meta}</div></div>`
    return renderer(item)
  }).join('')
  return `<div class="mozi-catalog-block">
    <div class="mozi-block-header mozi-block-header--sub">${escapeHtml(header)}</div>
    <div class="mozi-catalog-grid">${cards}</div>
  </div>`
}

// External rec items carry media_recommendations.id (NOT media_items.id).
// Clickable: opens ext rec detail popup with state buttons via /recommendations/:recId/act.
function renderExternalRecCard(item, reason) {
  extRecCache.set(item.id, item)
  const title = escapeHtml(String(item.title || ''))
  const year = item.year ? escapeHtml(String(item.year)) : ''
  const yearHtml = year ? `<div class="mozi-card-year">${year}</div>` : ''
  const poster = item.poster_url
    ? `<img class="mozi-card-poster" src="${escapeHtml(item.poster_url)}" alt="${title}" loading="lazy">`
    : `<div class="mozi-card-poster-placeholder">${item.type === 'series' ? '📺' : '🎬'}</div>`
  const reasonHtml = reason ? `<div class="mozi-rec-ext-reason">${escapeHtml(reason)}</div>` : ''
  return `<div class="mozi-card mozi-card--external" data-rec-id="${item.id}" onclick="moziOpenExtRecDetail(${item.id})">
    ${poster}
    <div class="mozi-card-body">
      <div class="mozi-card-title">${title}</div>
      ${yearHtml}
      ${reasonHtml}
    </div>
  </div>`
}

// ── External rec detail popup & act ───────────────────────────────────────

const EXT_REC_STATES = [
  { key: 'seen',           label: 'Láttam',      cls: 'seen' },
  { key: 'watchlist',      label: 'Megnézném',   cls: 'watchlist' },
  { key: 'in_progress',    label: 'Folyamatban', cls: 'in_progress' },
  { key: 'not_interested', label: 'Nem érdekel', cls: 'not_interested' },
]

function renderExtRecStatePicker(recId) {
  const btns = EXT_REC_STATES.map(s => {
    const onclick = s.key === 'seen'
      ? `event.stopPropagation();moziExtRecShowScorePicker(${recId})`
      : `event.stopPropagation();moziActOnExtRec(${recId},'${s.key}')`
    return `<button class="mozi-state-btn mozi-state-btn--${s.cls}" onclick="${onclick}">${escapeHtml(s.label)}</button>`
  }).join('')
  return `<div class="mozi-detail-picker" id="extRecStatePicker">
    <div class="mozi-detail-picker-label">Besorolás</div>
    <div class="mozi-state-btns">${btns}</div>
  </div>`
}

function moziExtRecShowScorePicker(recId) {
  const picker = document.getElementById('extRecStatePicker')
  if (!picker) return
  const scores = [1,2,3,4,5,6,7,8,9,10].map(i =>
    `<button class="mozi-score-btn" onclick="event.stopPropagation();moziActOnExtRec(${recId},'seen',${i})" title="${i}/10">${i}</button>`
  ).join('')
  picker.innerHTML = `<div class="mozi-detail-picker-label">Pont:</div>
    <div class="mozi-score-row">${scores}</div>
    <button class="mozi-inline-score-cancel" onclick="event.stopPropagation();moziExtRecRestorePicker(${recId})">Mégse</button>`
}

function moziExtRecRestorePicker(recId) {
  const picker = document.getElementById('extRecStatePicker')
  if (!picker) return
  picker.replaceWith(document.createRange().createContextualFragment(renderExtRecStatePicker(recId)))
}

function renderExtRecDetailBody(item) {
  const title = escapeHtml(String(item.title || ''))
  const year = item.year ? ` (${escapeHtml(String(item.year))})` : ''
  const poster = item.poster_url
    ? `<img class="mozi-detail-poster" src="${escapeHtml(item.poster_url)}" alt="${title}">`
    : `<div class="mozi-detail-poster-placeholder">${item.type === 'series' ? '📺' : '🎬'}</div>`
  const overviewHtml = item.overview
    ? `<div class="mozi-detail-overview">${escapeHtml(String(item.overview))}</div>`
    : ''
  const reasonHtml = item.reason
    ? `<div class="mozi-detail-reason"><em>${escapeHtml(String(item.reason))}</em></div>`
    : ''
  return `<div class="mozi-detail-top">
    ${poster}
    <div class="mozi-detail-info">
      <div class="mozi-detail-title">${title}${year}</div>
      ${reasonHtml}
      ${overviewHtml}
      ${renderExtRecStatePicker(item.id)}
    </div>
  </div>`
}

function moziOpenExtRecDetail(recId) {
  const item = extRecCache.get(recId)
  if (!item) return
  const overlay = document.getElementById('moziDetailOverlay')
  document.getElementById('moziDetailBody').innerHTML = renderExtRecDetailBody(item)
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}

async function moziActOnExtRec(recId, state, score) {
  if (!activeUser) return
  const userId = String(activeUser.id)
  try {
    const body = { userId: activeUser.id, state }
    if (score != null) body.score = score
    const data = await apiFetch(`/api/recommendations/${recId}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!data.ok) { showToast('Besorolás sikertelen.'); return }

    // Integrate returned item into catalog
    const newItem = data.item
    const mid = String(data.media_id)
    const existIdx = catalogItems.findIndex(i => i.id === data.media_id)
    if (existIdx >= 0) catalogItems[existIdx] = newItem
    else catalogItems.push(newItem)

    // Set status optimistically (backend already saved it)
    statusMap[mid] = statusMap[mid] || {}
    statusMap[mid][userId] = { state, score: state === 'seen' ? (score ?? null) : null }

    // Remove from personal rec cache so it won't re-appear
    if (recPersonalData) {
      recPersonalData.external = (recPersonalData.external || []).filter(i => i.id !== recId)
    }
    extRecCache.delete(recId)

    // Remove any group-rec card for this recId from DOM
    document.querySelectorAll(`.mozi-card--external[data-rec-id="${CSS.escape(String(recId))}"]`)
      .forEach(c => {
        const wrap = c.closest('.mozi-rec-item') || c
        wrap.remove()
      })

    moziCloseDetail()
    renderCatalog()

    // Refresh personal ajanlok section if visible
    if (activeTab === 'ajanlok') {
      const el = document.getElementById('ajanlokPersonal')
      if (el && recPersonalData) el.innerHTML = renderPersonalRec(recPersonalData)
    }
    showToast('Besorolva!')
  } catch (err) {
    showToast('Hiba: ' + err.message)
  }
}

function renderPersonalRec(data) {
  const internal = data.internal || []
  const external = data.external || []
  mergeRecItems(internal)  // external carries media_recommendations.id, not media_items.id -- do NOT merge
  const internalHtml = renderRecBlock('Házon belül ajánljuk', internal, item => likedByHtml(item.likedBy) || null)
  const externalHtml = renderRecBlock('Új neked', external, null, item => renderExternalRecCard(item, item.reason))
  return (internalHtml + externalHtml) || '<div class="mozi-empty">Még nincs személyes ajánlás -- pötyögjetek be pár pontot!</div>'
}

async function renderAjanlok() {
  const grid = document.getElementById('catalogGrid')
  if (!activeUser) return

  const userCheckboxes = usersCache.map(u => {
    const checked = u.id === activeUser.id ? 'checked' : ''
    return `<label class="mozi-group-user">
      <input type="checkbox" class="mozi-group-cb" value="${escapeHtml(String(u.id))}" ${checked}>
      <span class="mozi-avatar-sm" style="background:${escapeHtml(u.color || '#888')}">${escapeHtml(avatarInitials(u.name))}</span>
      <span class="mozi-group-user-name">${escapeHtml(u.name)}</span>
    </label>`
  }).join('')

  grid.innerHTML = `<div class="mozi-ajanlok">
    <section class="mozi-ajanlok-section">
      <div class="mozi-block-header">Személyes</div>
      <div id="ajanlokPersonal"><div class="mozi-loading">Betöltés...</div></div>
    </section>
    <section class="mozi-ajanlok-section">
      <div class="mozi-block-header">Közös este</div>
      <div class="mozi-group-selector">
        <div class="mozi-group-users">${userCheckboxes}</div>
        <button class="mozi-btn-primary" onclick="fetchGroupRec()">Mehet</button>
      </div>
      <div id="ajanlokGroup"></div>
    </section>
  </div>`

  if (recPersonalData) {
    const el = document.getElementById('ajanlokPersonal')
    if (el) el.innerHTML = renderPersonalRec(recPersonalData)
    return
  }

  try {
    const data = await apiFetch(`/api/recommend?user=${activeUser.id}`)
    if (activeTab !== 'ajanlok') return
    recPersonalData = data
    const el = document.getElementById('ajanlokPersonal')
    if (el) el.innerHTML = renderPersonalRec(data)
  } catch (_) {
    if (activeTab !== 'ajanlok') return
    const el = document.getElementById('ajanlokPersonal')
    if (el) el.innerHTML = '<div class="mozi-empty">Ajánlások nem tölthetők be.</div>'
  }
}

async function fetchGroupRec() {
  const groupEl = document.getElementById('ajanlokGroup')
  if (!groupEl) return
  const ids = [...document.querySelectorAll('.mozi-group-cb:checked')].map(cb => cb.value).join(',')
  if (!ids) { showToast('Legalább egy személyt jelölj be.'); return }
  groupEl.innerHTML = '<div class="mozi-loading">Betöltés...</div>'
  try {
    const data = await apiFetch(`/api/recommend/group?users=${ids}`)
    const internal  = data.internal  || []
    const external  = data.external  || []
    const watchlist = data.watchlist || []
    mergeRecItems([...internal, ...watchlist])  // external carries media_recommendations.id -- do NOT merge
    const html = [
      renderRecBlock('Mindkettőtöknek tetszhet', internal,  item => likedByHtml(item.likedBy) || null),
      renderRecBlock('Külső ajánlás',            external,  null, item => renderExternalRecCard(item, item.reason)),
      renderRecBlock('Valaki tervezi',           watchlist, item => item.reason ? `<span class="mozi-rec-reason">${escapeHtml(item.reason)}</span>` : null),
    ].join('')
    groupEl.innerHTML = html || '<div class="mozi-empty">Nincs közös ajánlás a kijelölt körre.</div>'
  } catch (err) {
    groupEl.innerHTML = `<div class="mozi-empty">Hiba: ${escapeHtml(err.message)}</div>`
  }
}

// ── Block rendering (Home / Neked új / Megnézném / Nem érdekel) ───────────
function renderBlock(header, items) {
  if (!items.length) return ''
  return `<div class="mozi-catalog-block">
    <div class="mozi-block-header">${escapeHtml(header)}</div>
    <div class="mozi-catalog-grid">${items.map(renderCard).join('')}</div>
  </div>`
}

// ── Catalog render ─────────────────────────────────────────────────────────
function renderCatalog() {
  const grid = document.getElementById('catalogGrid')
  const items = filterItems()

  const triageToggle = document.getElementById('moziTriageToggle')
  if (triageToggle) triageToggle.hidden = (activeTab !== 'none')

  const blockTabs = new Set(['home', 'none', 'watchlist', 'not_interested'])
  const isBlockMode = blockTabs.has(activeTab)
  grid.classList.toggle('mozi-catalog-blocks', isBlockMode)
  grid.classList.toggle('mozi-catalog-ajanlok', activeTab === 'ajanlok')

  if (activeTab === 'ajanlok') {
    renderAjanlok()
    return
  }

  if (activeTab === 'home') {
    const watchlistItems = items.filter(i => getUserStatus(i.id).state === 'watchlist')
    const noneItems     = items.filter(i => getUserStatus(i.id).state === 'none')
    const inProgItems   = items.filter(i => getUserStatus(i.id).state === 'in_progress')
    const html = [
      renderBlock('Megnézném', watchlistItems),
      renderBlock('Neked új', noneItems),
      renderBlock('Folyamatban', inProgItems),
    ].join('')
    grid.innerHTML = html || '<div class="mozi-empty">Nincs besorolatlan tétel.</div>'
    return
  }

  if (activeTab === 'none' || activeTab === 'watchlist' || activeTab === 'not_interested') {
    const filmItems   = items.filter(i => (i.type || 'film') === 'film')
    const seriesItems = items.filter(i => i.type === 'series')
    const html = [
      renderBlock('Filmek', filmItems),
      renderBlock('Sorozatok', seriesItems),
    ].join('')
    grid.innerHTML = html || '<div class="mozi-empty">Nincs ilyen tétel.</div>'
    return
  }

  // flat: Filmek / Sorozatok tab
  if (!items.length) {
    grid.innerHTML = '<div class="mozi-empty">Nincs találat.</div>'
    return
  }
  grid.innerHTML = items.map(renderCard).join('')
}

// ── Tab switching ──────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.mozi-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mozi-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTab = btn.dataset.tab
      // Exit triage when leaving 'none' tab
      if (activeTab !== 'none' && triageMode) exitTriageMode()
      renderCatalog()
    })
  })

  document.getElementById('moziTriageToggle').addEventListener('click', () => {
    if (triageMode) exitTriageMode()
    else enterTriageMode()
  })
}

// ── Triage bar bulk actions ────────────────────────────────────────────────
function initTriageBar() {
  document.querySelectorAll('[data-bulk-state]').forEach(btn => {
    btn.addEventListener('click', () => moziApplyBulkState(btn.dataset.bulkState))
  })
  document.getElementById('moziTriageCancel').addEventListener('click', exitTriageMode)
}

// ── Search ─────────────────────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById('moziSearch')
  const clear = document.getElementById('moziSearchClear')
  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase()
    clear.hidden = !input.value
    renderCatalog()
  })
  clear.addEventListener('click', () => {
    input.value = ''
    searchQuery = ''
    clear.hidden = true
    renderCatalog()
    input.focus()
  })
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  initSearch()
  initTabs()
  initTriageBar()

  document.getElementById('headerAdminBtn').addEventListener('click', openUserAdmin)
  document.getElementById('moziUserAdminClose').addEventListener('click', closeUserAdmin)
  document.getElementById('moziUserAdminOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeUserAdmin()
  })

  document.getElementById('headerSwitchBtn').addEventListener('click', () => {
    moziCloseDetail()
    activeUser = null
    recPersonalData = null
    localStorage.removeItem('mozi_active_user')
    updateHeader()
    searchQuery = ''
    triageMode = false
    selectedItems.clear()
    document.body.classList.remove('triage-active')
    document.getElementById('moziSearch').value = ''
    document.getElementById('moziSearchClear').hidden = true
    document.getElementById('moziTriageBar').hidden = true
    showPage('pagePicker')
  })

  // Detail modal
  document.getElementById('moziDetailClose').addEventListener('click', moziCloseDetail)
  document.getElementById('moziDetailOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) moziCloseDetail()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('moziUserAdminOverlay').classList.contains('active')) closeUserAdmin()
      else if (document.getElementById('moziDetailOverlay').classList.contains('active')) moziCloseDetail()
    }
  })

  // Setup wizard: AI provider toggle
  document.getElementById('setupAiProvider').addEventListener('change', e => {
    document.getElementById('setupAiKeyField').hidden = !e.target.value
  })

  // Setup wizard: form submit
  document.getElementById('setupForm').addEventListener('submit', async e => {
    e.preventDefault()
    const errEl = document.getElementById('setupError')
    errEl.hidden = true
    const name = document.getElementById('setupName').value.trim()
    const color = document.getElementById('setupColor').value
    const tmdbKey = document.getElementById('setupTmdb').value.trim()
    const aiProvider = document.getElementById('setupAiProvider').value
    const aiKey = document.getElementById('setupAiKey').value.trim()
    if (!name || !tmdbKey) return
    try {
      const res = await apiFetch('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ name, color, tmdbKey, aiProvider: aiProvider || undefined, aiKey: aiKey || undefined })
      })
      activeUser = { id: res.user.id, key: res.user.key, name: res.user.name, color: res.user.color, is_admin: 1 }
      localStorage.setItem('mozi_active_user', JSON.stringify(activeUser))
      updateHeader()
      await loadProfiles()
      openLibrary()
    } catch (err) {
      errEl.textContent = err.message || 'Hiba történt'
      errEl.hidden = false
    }
  })

  // Check if first-run setup is needed
  const setupStatus = await apiFetch('/api/setup/status')
  if (setupStatus.needsSetup) {
    showPage('pageSetup')
    return
  }

  restoreUser()
  loadProfiles()

  if (activeUser) {
    updateHeader()
    openLibrary()
  }
}

document.addEventListener('DOMContentLoaded', init)
