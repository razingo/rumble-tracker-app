'use strict';

// ---- helpers -----------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Opens an external link; in the exe's app window it is passed to the default browser via the server. */
async function openExternal(url) {
  if (state?.standalone) {
    try { await post('/api/open-external', { url }); return; } catch { /* fall back to a window here */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function quitTracker() {
  if (!confirm('Quit the tracker?\n\nIt stops watching your game and sending notifications until you start RumbleTracker.exe again.')) return;
  try { await post('/api/quit', {}); } catch { /* already gone */ }
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker has stopped</h1><p>You can close this window. Start RumbleTracker.exe to open it again.</p></main>';
  setTimeout(() => window.close(), 300);
}

// ---- state ---------------------------------------------------------------------
let RULES, MINIS, BY_SLUG, TAG_ICONS;
let ALWAYS_OWNED = []; // minis every player owns (not in the save; no progress)
let state = null;
let dirty = false;
const ui = {
  account: store.get('account', null),
  category: store.get('category', 'all'),
  show: store.get('show', 'owned'),
  sort: store.get('sort', 'level'),
  planCategory: store.get('planCategory', 'all'),
  planExpanded: store.get('planExpanded', false),
  tab: ['collection', 'army', 'armory', 'grid', 'calendar', 'pvp', 'progress'].includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('tab', 'collection'),
  filters: { types: [], families: [], traits: [], traitMode: 'all', ...store.get('filters', {}) },
  traitPickerOpen: false,
  traitSearch: '',
  open: null, // { kind: 'unit', id } | { kind: 'mini', slug }
  previewLevel: null,
};

const CATEGORIES = [['all', 'All'], ['Unit', 'Units'], ['Leader', 'Leaders'], ['Spell', 'Spells'], ['unknown', 'New / unknown']];

const rarityName = (r) => RULES.rarities[r]?.name ?? `Rarity ${r}`;
const rarityColor = (r) => `var(--r${r})`;
const miniOf = (u) => (u && u.slug ? BY_SLUG.get(u.slug) : null);
// a mini not yet in the game data (typically added by a patch)
const unitName = (u) => miniOf(u)?.name ?? `New mini ${u.id.slice(0, 8)}`;
// Known currencies are identified by ID (the same for every player); names are for display only.
const currencyOf = (role) => state.currencies.find((c) => c.id === RULES.currencyIds[role]);
const balance = (role) => currencyOf(role)?.balance ?? 0;
const curName = (role) => currencyOf(role)?.name || state.currencyNames?.[RULES.currencyIds[role]] || role;
const coreName = (role) => curName(role).replace(/s$/, '');

function nextUpgrade(u) {
  if (u.synthetic || u.rarity >= RULES.rarityUpgrade.length) return null;
  const step = RULES.rarityUpgrade[u.rarity];
  const starsOk = u.stars >= step.stars;
  const arcOk = balance('arcEnergy') >= step.arcEnergy;
  const coreOk = !step.core || balance(step.core) >= 1;
  return { ...step, starsOk, arcOk, coreOk, ready: starsOk && arcOk && coreOk };
}
const talentSlots = (u) => (u.synthetic ? 0 : RULES.talentSlotsByRarity[u.rarity] ?? 0);
const talentTotal = (u) => miniOf(u)?.talents.length ?? 3;
// A mini with every talent unlocked has all of them ticked.
const allTalentsOwned = (u) => talentTotal(u) > 0 && u.talents >= talentTotal(u);
const effectivePicks = (u) => (allTalentsOwned(u) ? [...Array(talentTotal(u)).keys()] : u.talentPicks);
function xpToMax(u) {
  if (u.xpLevel >= RULES.maxXpLevel) return 0;
  let total = Math.max(0, u.xpNeeded - u.xp);
  for (let l = u.xpLevel + 1; l < RULES.maxXpLevel; l++) total += RULES.xpToNext[l] || 0;
  return total;
}
// ---- army slots (leaders only, entered by the user) ----------------------------------------
const isLeader = (u) => !u.synthetic && miniOf(u)?.category === 'Leader';
// Slots 1-3 form the top row. With known fixed slots, 1-2 are locked and 3 is the fixed type or Wildcard.
// Slots 4-6 are free.
function fixedSlot(u, i) {
  const f = miniOf(u)?.fixedArmySlots;
  return f && i >= 1 && i <= 3 ? f[i - 1] || null : null;
}
const slotLocked = (u, i) => i >= 1 && i <= 2 && !!fixedSlot(u, i);
// legacy names for the Siege slot type
const SLOT_ALIASES = { 'Siege Damage': 'Siege', 'Siege Specialist': 'Siege' };
/** Slot types allowed in a leader's bottom slots (4-6), from its army board; never Wildcard. */
const bottomSlotOptions = (u) => miniOf(u)?.armySlotUpgrades || [];
function armyOf(u) {
  const A = RULES.armySlots;
  const saved = u.army || [];
  const used = new Set();
  return Array.from({ length: A.count }, (_, i) => {
    let type = i === A.leaderSlot ? 'Leader' : SLOT_ALIASES[saved[i]?.type] || saved[i]?.type || fixedSlot(u, i) || '';
    if (slotLocked(u, i)) type = fixedSlot(u, i);
    else if (i === 3 && fixedSlot(u, 3) && type !== 'Wildcard') type = fixedSlot(u, 3);
    else if (i >= 4) {
      // bottom row: a board type, no Wildcard, no repeats; invalid types read as empty
      const opts = bottomSlotOptions(u);
      if (type === 'Wildcard' || (opts.length && !opts.includes(type)) || used.has(type)) type = '';
      if (type) used.add(type);
    }
    return { type, tier: saved[i]?.tier || 0, boost: i === A.boostSlot && saved[i]?.boost === true };
  });
}
const hasBoost = (u) => isLeader(u) && armyOf(u)[RULES.armySlots.boostSlot].boost;
// A leader occupies its Leader slot, so that slot's bonus is part of its level.
const leaderSlotBonus = (u) => (isLeader(u) ? RULES.armySlots.tiers[armyOf(u)[RULES.armySlots.leaderSlot].tier]?.bonus || 0 : 0);
const totalLevel = (u) => u.level + leaderSlotBonus(u);

function armyTotals(units) {
  const A = RULES.armySlots;
  const diamond = A.tiers.length - 1;
  const t = { leaders: 0, slots: 0, diamonds: 0, goldReady: 0, notDiamond: 0, cost: A.diamondValorCost };
  for (const u of units) {
    if (!isLeader(u)) continue;
    t.leaders++;
    for (const s of armyOf(u)) {
      t.slots++;
      if (s.tier === diamond) t.diamonds++;
      else { t.notDiamond++; if (s.tier === diamond - 1) t.goldReady++; }
    }
  }
  return t;
}

function remainingToLegendary(u) {
  const out = { arcEnergy: 0, stars: 0, cores: {} };
  if (u.synthetic) return out;
  for (let r = u.rarity; r < RULES.rarityUpgrade.length; r++) {
    const s = RULES.rarityUpgrade[r];
    out.arcEnergy += s.arcEnergy;
    out.stars += r === u.rarity ? Math.max(0, s.stars - u.stars) : s.stars;
    if (s.core) out.cores[s.core] = (out.cores[s.core] || 0) + 1;
  }
  return out;
}

// ---- data loading ----------------------------------------------------------------
async function loadTables() {
  [RULES, MINIS] = await Promise.all([
    fetch('/static/rules.json').then((r) => r.json()),
    fetch('/static/minis.json').then((r) => r.json()).then((d) => {
      // Wildcard and Leader icons are not in minis.json
      TAG_ICONS = { Wildcard: 'icons/Wildcard.png', Leader: 'icons/Leader.png', ...(d.tagIcons || {}) };
      ALWAYS_OWNED = d.minis.filter((m) => m.alwaysOwned);
      return d.minis;
    }),
  ]);
  BY_SLUG = new Map(MINIS.map((m) => [m.slug, m]));
}

/** After a data-pack update: reloads every game table (the tab scripts load theirs again when next needed). */
async function reloadTables() {
  try {
    await loadTables();
    EVENTS = null; STORE = null; PVP = null; CODE_TABLE = null;
  } catch { /* keep the old tables; tried again at the next change */ }
}

async function boot() {
  await loadTables();
  // tab scripts load after this one and may not have run yet
  await pageScriptsLoaded;
  $('#show').value = ui.show;
  $('#sort').value = ui.sort;
  bindStatic();
  bindArmy();
  bindArmory();
  bindCalendar();
  bindGridTab();
  bindPvp();
  bindNotify();
  bindReport();
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  setTab(ui.tab);
  await poll();
  setInterval(poll, 4000);
  setInterval(renderStatus, 1000);
}

// state fields that change without a new revision (the server's liveState)
const LIVE_FIELDS = ['lastScan', 'lastError', 'problems', 'gameRunning', 'update'];

async function poll() {
  try {
    const q = new URLSearchParams();
    if (ui.account) q.set('account', ui.account);
    // with the revision the page has, an unchanged state is answered with the live fields only
    if (state && !state.connError) { q.set('rev', String(state.rev)); q.set('for', String(state.account)); }
    const r = await fetch(`/api/state?${q}`);
    const s = await r.json();
    if (s.unchanged && state) {
      for (const k of LIVE_FIELDS) state[k] = s[k];
      state.connError = null;
      renderUpdate();
      renderStatus();
      renderReportBadge();
      return;
    }
    // a new tracker version (after an update): load its page
    if (state?.appVersion && s.appVersion && s.appVersion !== state.appVersion) { location.reload(); return; }
    // new game data (a data pack arrived): reload the tables before drawing
    const dataVersion = s.dataStatus?.dataVersion || null;
    if (state && dataVersion !== state.dataStatus?.dataVersion) await reloadTables();
    for (const m of ALWAYS_OWNED) {
      if (s.account && !s.units.some((u) => u.slug === m.slug)) {
        s.units.push({ id: `always-${m.slug}`, slug: m.slug, synthetic: true, level: 0, xp: 0, xpNeeded: 0, xpLevel: RULES.maxXpLevel, bonus: 0, talents: 0, rarity: 0, stars: 0, talentPicks: [] });
      }
    }
    const changed = !state || s.rev !== state.rev || s.account !== state.account;
    state = s;
    ui.account = s.account;
    state.connError = null;
    $('#quitBtn').hidden = !s.standalone;
    if (s.appVersion) { $('#appVersion').textContent = `v${s.appVersion}`; $('#appVersion').hidden = false; }
    if (changed) requestRender();
    renderUpdate();
  } catch (e) {
    if (state) state.connError = 'Tracker server not reachable';
  }
  renderStatus();
  renderReportBadge();
}

// Defer redraws while the user is editing a field.
function requestRender() {
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && !a.closest('.drawer-body') && a.id !== 'show' && a.id !== 'sort') {
    dirty = true;
    return;
  }
  dirty = false;
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (dirty) requestRender(); }, 0));

// ---- rendering ------------------------------------------------------------------------
function setTab(tab) {
  ui.tab = tab;
  store.set('tab', tab);
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#tab-collection').hidden = tab !== 'collection';
  $('#tab-army').hidden = tab !== 'army';
  $('#tab-armory').hidden = tab !== 'armory';
  $('#tab-calendar').hidden = tab !== 'calendar';
  $('#tab-pvp').hidden = tab !== 'pvp';
  $('#tab-grid').hidden = tab !== 'grid';
  $('#tab-progress').hidden = tab !== 'progress';
  if (tab === 'progress') renderProgress();
  if (tab === 'army') renderArmy();
  if (tab === 'armory') renderArmory();
  if (tab === 'calendar') renderCalendar();
  if (tab === 'pvp') renderPvp();
  if (tab === 'grid') renderGridTab();
}

function render() {
  if (!state) return;
  renderDataBanner();
  renderAccounts();
  if (ui.tab === 'army') renderArmy();
  if (ui.tab === 'armory') renderArmory();
  if (ui.tab === 'calendar') renderCalendar();
  if (ui.tab === 'pvp') renderPvp();
  if (ui.tab === 'grid') renderGridTab();
  if (ui.tab === 'progress') renderProgress();
  renderCurrencies();
  renderSummary();
  renderNeeds();
  renderPlanner();
  renderFilters();
  renderGrid();
  renderEvents();
  if (ui.open) renderDrawer();
}

const RELEASES_URL = 'https://github.com/razingo/rumble-tracker-app/releases/latest';

/** Banner when a newer tracker version is needed for game-data updates, or when the game is newer than the data. */
function renderDataBanner() {
  const el = $('#dataBanner');
  const d = state?.dataStatus;
  if (!el) return;
  if (d?.pack?.needsAppUpdate) {
    el.hidden = false;
    el.innerHTML = `<b>A newer version of the tracker is needed.</b> New game data can't be verified by this version, so
      it isn't installed. Download the latest RumbleTracker from GitHub Releases; your data is kept.
      <button class="chip" data-open-releases>Download the latest version</button>`;
    return;
  }
  el.hidden = !d?.stale;
  if (!d?.stale) return;
  el.innerHTML = `<b>The game was updated to ${esc(d.gameBuild)}.</b> The tracker's game data is from ${esc(d.dataBuild)}, so new minis,
    events or shop offers may be missing or unnamed until a data update arrives${d.pack?.configured ? ' (it checks for one every 6 hours)' : ''}.
    Your own progress is read from the game as usual.`;
}

/**
 * Pop-up for a new tracker version (state.update). Download now: the exe downloads, verifies and installs it, then
 * restarts; from source (or without download checksums) it opens GitHub Releases. Later: hidden until the tracker
 * restarts.
 */
let updateShown = null; // what the dialog shows: '<version>:<state>'
function renderUpdate() {
  const dlg = $('#updateDialog');
  const u = state?.update;
  // while restarting, the server is gone for a moment: keep showing it
  const busy = u && (u.state === 'downloading' || u.state === 'restarting');
  const show = u && (busy || !u.later);
  if (!show && !(updateShown?.endsWith(':restarting') && state?.connError)) {
    if (dlg.open) dlg.close();
    updateShown = null;
    return;
  }
  if (!u) return;
  const key = `${u.version}:${u.state}:${u.error || ''}`;
  if (key !== updateShown) {
    updateShown = key;
    const head = `<div class="nt-head"><h2>Version ${esc(u.version)} is available</h2></div>`;
    let body;
    if (u.state === 'downloading') body = '<p>Downloading and checking the new version…</p>';
    else if (u.state === 'restarting') body = '<p>Installing: the tracker restarts in a moment and this window reloads by itself.</p>';
    else {
      body = `${u.state === 'failed' ? `<p class="cost-no">The update didn't work: ${esc(u.error || 'unknown error')}</p>` : ''}
        <p>${u.auto ? 'The tracker can download and install it now, then restart. Your data is kept.' : 'Download it from GitHub Releases; your data is kept.'}</p>
        <div class="nt-actions"><button class="btn" data-update-now>${u.auto && u.state !== 'failed' ? 'Download now' : 'Open GitHub Releases'}</button>
          <button class="chip" data-update-later>Later</button></div>`;
    }
    dlg.innerHTML = `<div class="nt-form">${head}${body}</div>`;
  }
  if (!dlg.open) dlg.showModal();
}

async function updateNow() {
  const u = state?.update;
  if (!u) return;
  if (!u.auto || u.state === 'failed') { openExternal(RELEASES_URL); return updateLater(); }
  try { await post('/api/update', {}); } catch (e) { alert(`The update could not start: ${e.message}`); }
  poll();
}
async function updateLater() {
  try { await post('/api/update/later', {}); } catch { /* the server is gone */ }
  if (state?.update) state.update.later = true;
  renderUpdate();
}

function renderStatus() {
  const el = $('#status');
  if (!state) return;
  const err = state.connError || state.lastError;
  const live = state.gameRunning === false ? `Game closed · last read ${ago(state.lastScan)}` : `Live · last scan ${ago(state.lastScan)}`;
  el.className = `status${err ? ' error' : state.gameRunning === false ? ' idle' : ''}`;
  el.innerHTML = `<span class="dot"></span><span class="status-text">${err ? esc(err) : live}</span>`;
}

function renderAccounts() {
  const sel = $('#account');
  sel.innerHTML = state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.account ? 'selected' : ''}>${esc(a.label)} (${a.units} minis)</option>`).join('');
  if (!state.accounts.length) sel.innerHTML = '<option>No Rumble data found on this PC</option>';
  const current = state.accounts.find((a) => a.id === state.account);
  const input = $('#accountLabel');
  if (document.activeElement !== input) input.value = current && !current.label.startsWith('Account …') ? current.label : '';
}

// G.R.I.D. currencies, shown on the G.R.I.D. tab instead of the Collection (save IDs).
const GRID_CURRENCY_IDS = [
  '44b7dad7dfaa4aae8eb69b8dbf6968b8', // Big Red Buttons
  'e1f4dd57cf836abed7875b0b33bb87e8', // Rare-O-Matics
  '38547868a0830bd6fa60ffc4440983a8', // Modest Tinker's Gems
  '74c4595e80588d652ab5bc38691b79c9', // Major Tinker's Gems
  '97b4103c5c0740da8488d67801c30c2b', // Mega Tinker's Gems
];

// Ankh ("used to continue failed dungeons"), shown on the Calendar's Dungeon card instead of the Collection.
const ANKH_ID = '32141a9ef28487c729b80616d70185ba';

/** Currency chip: icon, name and balance; lifetime total as tooltip. */
function currencyChip(c) {
  const icon = RULES.currencyIcons?.[c.id];
  return `<div class="cur" title="${esc(c.name)} · earned all time: ${fmt(c.lifetime)}">${icon ? `<img class="cur-ico" src="/static/${icon}" alt="">` : ''}<span>${esc(c.name)}</span><b>${fmt(c.balance)}</b></div>`;
}

function renderCurrencies() {
  // event tickets, Ankh and G.R.I.D. currencies are on other tabs
  const named = state.currencies.filter((c) => c.name && !EVENT_CURRENCY_IDS.has(c.id) && !GRID_CURRENCY_IDS.includes(c.id) && c.id !== ANKH_ID);
  const order = ['coins', 'arcEnergy', 'rareCore', 'epicCore', 'legendaryCore', 'valor'].map((r) => RULES.currencyIds[r]);
  named.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  $('#currencies').innerHTML = named.map(currencyChip).join('');
}

function renderSummary() {
  const units = state.units;
  const identified = units.filter((u) => u.slug).length;
  const ready = units.filter((u) => nextUpgrade(u)?.ready).length;
  const openSlots = units.reduce((n, u) => n + Math.max(0, talentSlots(u) - u.talents), 0);
  const picksMissing = units.filter((u) => u.talents > effectivePicks(u).length).length;
  const toLeg = units.reduce((acc, u) => { const r = remainingToLegendary(u); acc.arcEnergy += r.arcEnergy; for (const [k, v] of Object.entries(r.cores)) acc.cores[k] = (acc.cores[k] || 0) + v; return acc; }, { arcEnergy: 0, cores: {} });
  const coresText = Object.entries(toLeg.cores).map(([k, v]) => `${v} ${coreName(k).replace(/ Upgrade Core$/, '')}`).join(', ') || 'none';
  $('#summary').innerHTML = [
    ['Minis owned', `${units.length} / ${MINIS.length}`, `${identified} identified`],
    ['Upgrades ready now', ready, `enough stars, ${curName('arcEnergy')} and cores`],
    ['Open talent slots', openSlots, 'buy in the G.R.I.D.'],
    ['Talents to tick', picksMissing, 'minis with unrecorded talents'],
    [`${curName('arcEnergy')} to all legendary`, fmt(toLeg.arcEnergy), `upgrade cores: ${coresText}`],
    ...(() => {
      const a = armyTotals(units);
      if (!a.leaders) return [];
      return [[`${curName('valor')} for Diamond slots`, fmt(a.goldReady * a.cost),
        `${a.goldReady} Gold slot${a.goldReady === 1 ? '' : 's'} ready · ${fmt(a.notDiamond * a.cost)} for all ${a.slots} · have ${fmt(balance('valor'))}`]];
    })(),
  ].map(([k, v, s]) => `<div class="stat-card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="small">${esc(s)}</div></div>`).join('');
}

function lastEventFor(id) {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].id === id) return state.events[i];
  return null;
}

function miniOptions(currentSlug) {
  const taken = new Set(state.units.map((u) => u.slug).filter(Boolean));
  const groups = { Unit: [], Leader: [], Spell: [] };
  for (const m of MINIS) if (!taken.has(m.slug) || m.slug === currentSlug) groups[m.category].push(m);
  return '<option value="">Choose a mini…</option>' + Object.entries(groups)
    .map(([g, list]) => `<optgroup label="${g}s">${list.map((m) => `<option value="${m.slug}">${esc(m.name)}</option>`).join('')}</optgroup>`)
    .join('');
}

function renderNeeds() {
  const unknownUnits = state.units.filter((u) => !u.slug)
    .sort((a, b) => (lastEventFor(b.id)?.t || '').localeCompare(lastEventFor(a.id)?.t || ''));
  const rows = [];
  for (const u of unknownUnits.slice(0, 12)) {
    const ev = lastEventFor(u.id);
    rows.push(`<div class="row" data-unit-row="${u.id}">
      <div class="what"><b>New mini (not in the tracker's data yet)</b> <span class="mono muted">${u.id.slice(0, 8)}</span><br>
        <span class="small">${rarityName(u.rarity)} · level ${totalLevel(u)} · XP level ${u.xpLevel}${u.xpLevel < RULES.maxXpLevel ? ` (${u.xp}/${u.xpNeeded})` : ' (max)'} · ${u.stars} stars${ev ? ` · last change: ${esc(eventText(ev))} ${ago(ev.t)}` : ''}</span></div>
      <select class="keep" data-name-unit="${u.id}">${miniOptions(null)}</select>
      <button class="btn" data-save-unit="${u.id}">Save</button></div>`);
  }
  if (unknownUnits.length > 12) rows.push(`<div class="row small">…and ${unknownUnits.length - 12} more. Tip: level up or upgrade a mini in the game and it moves to the top, ready to name.</div>`);
  // shown only when something needs naming
  $('#needs').hidden = rows.length === 0;
  $('#needs').innerHTML = rows.length ? `<h2>Needs your input (${unknownUnits.length})</h2>${rows.join('')}` : '';
}

// ---- planner: which minis are closest to their next level / rarity ------------------------
const PLAN_SIZE = 8;

function planArt(u) {
  const m = miniOf(u);
  return m ? `<img src="/static/${m.art}" alt="" loading="lazy">` : '<div class="art unknown">?</div>';
}

function planRow(u, pct, label, togo, togoUnit, extra = '') {
  return `<button class="plan-row" style="--rc:${rarityColor(u.rarity)}" data-open-unit="${u.id}">
    ${planArt(u)}
    <div><b>${esc(unitName(u))}</b> <span class="small">${esc(label)}</span>
      <div class="bar${togoUnit === 'stars' ? ' stars' : ''}"><span style="width:${pct}%"></span></div>${extra}</div>
    <div class="togo">${fmt(togo)}<small>${togoUnit} to go</small></div>
  </button>`;
}

function renderPlanner() {
  // type and faction filters apply; trait filters affect only the grid
  const pool = state.units.filter((u) => !u.synthetic && passes(miniOf(u), 'traits'));
  const narrowed = ui.filters.types.length + ui.filters.families.length > 0;

  const byXp = pool
    .filter((u) => u.xpLevel < RULES.maxXpLevel && u.xpNeeded > 0)
    .map((u) => ({ u, pct: u.xp / u.xpNeeded, togo: u.xpNeeded - u.xp }))
    .sort((a, b) => b.pct - a.pct || a.togo - b.togo)
    .slice(0, PLAN_SIZE);
  // collapsed to one row per list; "Show more" expands to PLAN_SIZE
  const expanded = !!ui.planExpanded;

  const byStars = pool
    .map((u) => ({ u, up: nextUpgrade(u) }))
    .filter(({ up }) => up)
    .map(({ u, up }) => ({ u, up, pct: Math.min(1, u.stars / up.stars), togo: Math.max(0, up.stars - u.stars) }))
    .sort((a, b) => b.pct - a.pct || a.togo - b.togo || a.up.arcEnergy - b.up.arcEnergy)
    .slice(0, PLAN_SIZE);

  const moreAvailable = byXp.length > 1 || byStars.length > 1;
  const shownXp = expanded ? byXp : byXp.slice(0, 1);
  const shownStars = expanded ? byStars : byStars.slice(0, 1);

  const xpHtml = shownXp.map(({ u, pct, togo }) =>
    planRow(u, Math.round(pct * 100), `XP level ${u.xpLevel} → ${u.xpLevel + 1} · ${fmt(u.xp)}/${fmt(u.xpNeeded)}`, togo, 'XP')).join('');

  const starsHtml = shownStars.map(({ u, up, pct, togo }) => {
    const costs = [`${fmt(up.arcEnergy)} ${curName('arcEnergy')}`, up.core ? `1 ${coreName(up.core)}` : null].filter(Boolean).join(' + ');
    const status = up.ready
      ? '<span class="flag good">Ready - upgrade now</span>'
      : togo === 0
        ? `<span class="flag warn">Stars done · need ${[!up.arcOk ? curName('arcEnergy') : '', !up.coreOk ? coreName(up.core) : ''].filter(Boolean).join(' + ')}</span>`
        : '';
    return planRow(u, Math.round(pct * 100), `${rarityName(u.rarity)} → ${rarityName(up.to)} · ${u.stars}/${up.stars} stars · ${costs}`, togo, 'stars',
      status ? `<div class="flags" style="margin-top:4px">${status}</div>` : '');
  }).join('');

  const empty = (txt) => `<div class="small">${pool.length ? txt : 'No owned minis match the filters.'}</div>`;
  $('#planner').innerHTML = `<div class="planner-head"><h2>Closest to next step</h2>
      <span class="small">${narrowed ? `Filtered: ${pool.length} of ${state.units.length} minis` : `All ${state.units.length} minis`}</span></div>
    <div class="planner-cols">
      <div><h3>Next level (XP)</h3>${xpHtml || empty('Every mini here is at XP level 20.')}</div>
      <div><h3>Next rarity (stars)</h3>${starsHtml || empty('Every mini here is Legendary.')}</div>
    </div>
    ${moreAvailable ? `<div class="planner-more"><button class="chip" data-plan-toggle aria-expanded="${expanded}">${expanded ? 'Show less ▴' : `Show more (top ${PLAN_SIZE}) ▾`}</button></div>` : ''}`;
}

// ---- collection filters: type, faction, traits (all multi-select) ---------------------------
const TYPES = [['Unit', 'Units'], ['Leader', 'Leaders'], ['Spell', 'Spells'], ['unknown', 'New / unknown']];
const FAMILIES = ['Alliance', 'Horde', 'Undead', 'Beast', 'Blackrock', 'Cenarion'];

function allTraits() {
  const map = new Map();
  for (const m of MINIS) for (const t of m.traits) if (!map.has(t.name)) map.set(t.name, t);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a mini (null: unidentified) passes the filters; `skip` ignores one group, for facet counts. */
function passes(m, skip) {
  const f = ui.filters;
  if (skip !== 'types' && f.types.length && !f.types.includes(m ? m.category : 'unknown')) return false;
  // dual-faction leaders match either faction
  if (skip !== 'families' && f.families.length && !(m && familiesOf(m).some((x) => f.families.includes(x)))) return false;
  if (skip !== 'traits' && f.traits.length) {
    if (!m) return false;
    const has = new Set(m.traits.map((t) => t.name));
    const ok = f.traitMode === 'any' ? f.traits.some((t) => has.has(t)) : f.traits.every((t) => has.has(t));
    if (!ok) return false;
  }
  return true;
}

/** Grid items: owned units, plus unowned minis when "Owned + not owned" is selected. */
function gridPool() {
  const pool = state.units.map((u) => ({ unit: u, mini: miniOf(u) }));
  if (ui.show === 'all') {
    const owned = new Set(state.units.map((u) => u.slug));
    for (const m of MINIS) if (!owned.has(m.slug)) pool.push({ unit: null, mini: m });
  }
  return pool;
}

const filtersActive = () => ui.filters.types.length + ui.filters.families.length + ui.filters.traits.length > 0;

function saveFilters() { store.set('filters', ui.filters); }

function toggleIn(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1); else list.push(value);
}

function renderFilters() {
  const f = ui.filters;
  const pool = gridPool();
  const count = (group, test) => pool.filter(({ mini }) => passes(mini, group) && test(mini)).length;

  const typeChips = TYPES
    .filter(([k]) => k !== 'unknown' || state.units.some((u) => !u.slug))
    .map(([k, label]) => `<button class="chip" aria-pressed="${f.types.includes(k)}" data-f-type="${k}">${label}<small>${count('types', (m) => (m ? m.category : 'unknown') === k)}</small></button>`)
    .join('');

  const famChips = FAMILIES
    .map((fam) => `<button class="chip" aria-pressed="${f.families.includes(fam)}" data-f-family="${fam}">${ico(TAG_ICONS[fam], fam)}${fam}<small>${count('families', (m) => !!m && familiesOf(m).includes(fam))}</small></button>`)
    .join('');

  const traits = allTraits();
  const traitCount = (name) => count('traits', (m) => !!m && m.traits.some((t) => t.name === name));
  // floating trait picker: match mode on top, selected traits first
  const opt = (t) => `<label class="trait-opt" data-trait-name="${esc(t.name.toLowerCase())}">
      <input type="checkbox" data-f-trait-box="${esc(t.name)}" ${f.traits.includes(t.name) ? 'checked' : ''}>
      ${ico(t.icon, t.name)}<span>${esc(t.name)}</span><small>${traitCount(t.name)}</small></label>`;
  const ticked = traits.filter((t) => f.traits.includes(t.name));
  const rest = traits.filter((t) => !f.traits.includes(t.name));
  const any = f.traitMode === 'any';
  const popup = ui.traitPickerOpen ? `<div class="trait-pop" role="dialog" aria-label="Traits">
      <div class="trait-pop-head">
        <span class="seg"><button class="chip small-chip" aria-pressed="${!any}" data-trait-mode="all" title="Minis with every selected trait">Match all</button><button class="chip small-chip" aria-pressed="${any}" data-trait-mode="any" title="Minis with any selected trait">Match any</button></span>
        ${f.traits.length ? '<button class="chip small-chip" data-clear-traits>Clear</button>' : ''}
      </div>
      <input class="trait-search" type="search" placeholder="Search traits…" value="${esc(ui.traitSearch)}">
      <div class="trait-list">${ticked.map(opt).join('')}${ticked.length && rest.length ? '<hr class="trait-sep">' : ''}${rest.map(opt).join('')}</div>
    </div>` : '';

  $('#filters').innerHTML = `
    <div class="filter-row"><span class="filter-label">Type</span><div class="chips">${typeChips}</div></div>
    <div class="filter-row"><span class="filter-label">Faction</span><div class="chips">${famChips}</div></div>
    <div class="filter-row"><span class="filter-label">Traits</span>
      <div class="chips">
        <span class="trait-anchor"><button class="chip picker-btn" aria-expanded="${ui.traitPickerOpen}" aria-pressed="${f.traits.length > 0}" data-trait-picker>${f.traits.length ? `${f.traits.length} selected` : 'Choose traits'} ▾</button>${popup}</span>
      </div>
      <button class="chip clear-filters" data-clear-filters ${filtersActive() ? '' : 'disabled'}>✕ Clear filters</button>
    </div>`;
  applyTraitSearch();
}

function applyTraitSearch() {
  const q = ui.traitSearch.trim().toLowerCase();
  for (const el of document.querySelectorAll('#filters .trait-opt')) el.hidden = !!q && !el.dataset.traitName.includes(q);
}

/** Card frame class for the mini's family (theme-art.css). */
const frameCls = (m) => `frame-${String(m?.family || 'neutral').toLowerCase()}`;

function cardForUnit(u) {
  const m = miniOf(u);
  if (u.synthetic) {
    return `<button class="card ${frameCls(m)}" data-open-unit="${u.id}">
      <img class="art" src="/static/${m.art}" alt="" loading="lazy">
      <div class="name">${esc(m.name)}</div>
      <div class="meta">${m.category} · ${esc(m.family)}</div>
      <div class="small">Always owned · no levels or upgrades</div>
    </button>`;
  }
  const up = nextUpgrade(u);
  const slots = talentSlots(u);
  const flags = [];
  if (up?.ready) flags.push('<span class="flag good">Upgrade ready</span>');
  if (u.talents < slots) flags.push('<span class="flag good">Talent slot open</span>');
  if (effectivePicks(u).length < u.talents) flags.push('<span class="flag warn">Tick talents</span>');
  if (isLeader(u) && armyOf(u).some((s) => s.type === 'Wildcard')) flags.push(`<span class="flag wild">${ico(TAG_ICONS.Wildcard, 'Wildcard')}Wildcard</span>`);
  if (hasBoost(u)) flags.push('<span class="flag boost" title="Its army has a Boost slot: that mini plays at XP level 20"><svg class="boost-bolt" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 0 2 9h5l-1.5 7L14 6.5H8.8z"/></svg>Boost</span>');
  const xpPct = u.xpLevel >= RULES.maxXpLevel ? 100 : Math.round((u.xp / Math.max(1, u.xpNeeded)) * 100);
  const starsTxt = up ? `${u.stars}/${up.stars} stars` : 'Max rarity';
  const starsPct = up ? Math.min(100, Math.round((u.stars / up.stars) * 100)) : 100;
  return `<button class="card ${frameCls(m)}${isLeader(u) ? ' leader' : ''}" style="--rc:${rarityColor(u.rarity)}" data-open-unit="${u.id}">
    ${m ? `<img class="art" src="/static/${m.art}" alt="" loading="lazy">` : '<div class="art unknown">?</div>'}
    <div class="lvl">${totalLevel(u)}<small>level</small></div>
    <div class="name">${esc(unitName(u))}</div>
    <div class="meta">${rarityName(u.rarity)}${m ? ` · ${m.category}` : ''}</div>
    <div class="bar"><span style="width:${xpPct}%"></span></div>
    <div class="small">${u.xpLevel >= RULES.maxXpLevel ? 'XP level 20 (max)' : `XP level ${u.xpLevel} · ${fmt(u.xp)}/${fmt(u.xpNeeded)}`}</div>
    <div class="bar stars"><span style="width:${starsPct}%"></span></div>
    <div class="small">${starsTxt} · talents ${u.talents}/${slots}</div>
    ${isLeader(u) ? armyStrip(u) : ''}
    <div class="flags">${flags.join('')}</div>
  </button>`;
}

function armyStrip(u) {
  const tiers = RULES.armySlots.tiers;
  const cells = armyOf(u).map((s) => {
    const t = tiers[s.tier];
    return `<span class="army-cell${s.type === 'Wildcard' ? ' wild' : ''}${s.boost ? ' boost' : ''}" style="--tc:${t.color}" title="${esc(s.type || 'Type not set')}: ${t.name}${t.bonus ? ` (+${t.bonus})` : ''}${s.boost ? ' · Boost' : ''}"></span>`;
  }).join('');
  return `<div class="army-strip" aria-label="Army slots">${cells}</div>`;
}

function cardForMissing(m) {
  return `<button class="card missing ${frameCls(m)}" data-open-mini="${m.slug}">
    <img class="art" src="/static/${m.art}" alt="" loading="lazy">
    <div class="name">${esc(m.name)}</div>
    <div class="meta">${m.category} · ${esc(m.family)}</div>
    <div class="small">Not owned${state.units.some((u) => !u.slug) ? ' or not identified yet' : ''}</div>
  </button>`;
}

function sortUnits(list) {
  const by = {
    level: (a, b) => totalLevel(b) - totalLevel(a) || unitName(a).localeCompare(unitName(b)),
    name: (a, b) => unitName(a).localeCompare(unitName(b)),
    rarity: (a, b) => b.rarity - a.rarity || totalLevel(b) - totalLevel(a),
    ready: (a, b) => (nextUpgrade(b)?.ready ? 1 : 0) - (nextUpgrade(a)?.ready ? 1 : 0) || totalLevel(b) - totalLevel(a),
  }[ui.sort];
  return [...list].sort(by);
}

function renderGrid() {
  const pool = gridPool().filter(({ mini }) => passes(mini));
  const units = sortUnits(pool.filter((p) => p.unit).map((p) => p.unit));
  const missing = pool.filter((p) => !p.unit).map((p) => p.mini).sort((a, b) => a.name.localeCompare(b.name));
  const html = units.map(cardForUnit).join('') + missing.map(cardForMissing).join('');
  const total = state.units.length + (ui.show === 'all' ? MINIS.length - new Set(state.units.map((u) => u.slug).filter(Boolean)).size : 0);
  $('#gridCount').textContent = filtersActive() ? `Showing ${units.length + missing.length} of ${total}` : `${total} minis`;
  $('#grid').innerHTML = html || '<p class="muted">No minis match these filters.</p>';
}

function eventText(e) {
  const u = state.units.find((x) => x.id === e.id);
  const who = u ? unitName(u) : null;
  const cur = state.currencies.find((x) => x.id === e.id);
  switch (e.type) {
    case 'unit_new': return `${who} joined your collection`;
    case 'unit_xp': return `${who} +${fmt(e.gained)} XP${e.to.level !== e.from.level ? ` → XP level ${e.to.level}` : ''}`;
    case 'unit_rarity': return `${who} upgraded to ${rarityName(e.to)}`;
    case 'unit_talent': return `${who} unlocked a talent (${e.to} total)`;
    case 'unit_stars': return `${who} stars ${e.from} → ${e.to}`;
    case 'currency': return `${cur?.name || `Currency ${e.id.slice(0, 8)}`} ${e.delta > 0 ? '+' : ''}${fmt(e.delta)} (now ${fmt(e.to)})`;
    default: return e.type;
  }
}

function renderEvents() {
  const list = state.events.slice(-25).reverse(); // latest 25
  $('#eventsCount').textContent = list.length ? `· latest ${list.length}` : '';
  $('#events').innerHTML = list.length
    ? list.map((e) => `<li><time>${ago(e.t)}</time>${esc(eventText(e))}</li>`).join('')
    : '<li class="muted">No changes yet. Play a battle or upgrade a mini and it shows up here.</li>';
}

// ---- detail drawer ---------------------------------------------------------------------
const ico = (path, title = '') => (path ? `<img class="ico" src="/static/${path}" alt="" title="${esc(title)}">` : '');
const tag = (name) => `<span class="tag-pill">${ico(TAG_ICONS[name], name)}${esc(name)}</span>`;
function statRows(m, level) {
  return Object.entries(m.stats).map(([k, v]) => {
    const val = Array.isArray(v) ? v[Math.min(v.length, level) - 1] : v;
    return `<tr><td>${esc(k)}</td><td>${esc(typeof val === 'number' ? fmt(val) : val)}</td></tr>`;
  }).join('');
}

function armyEditor(u, m) {
  const A = RULES.armySlots;
  const slots = armyOf(u);
  const bottom = bottomSlotOptions(u);
  const cells = slots.map((s, i) => {
    const t = A.tiers[s.tier];
    const isLeaderSlot = i === A.leaderSlot;
    const fixed3 = i === 3 ? fixedSlot(u, 3) : null;
    // slot 3: fixed type or Wildcard; slots 4-6: board types, each used at most once
    const takenElsewhere = new Set(slots.filter((x, k) => k >= 4 && k !== i && x.type).map((x) => x.type));
    const opts = fixed3 ? [fixed3, 'Wildcard']
      : i === 3 ? ['Wildcard', ...bottom]
        : bottom.filter((o) => !takenElsewhere.has(o) || o === s.type);
    const typeCtl = isLeaderSlot
      ? `<div class="slot-type">${ico(TAG_ICONS.Leader, 'Leader')}Leader</div>`
      : slotLocked(u, i)
        ? `<div class="slot-type" title="Set by this leader">${ico(TAG_ICONS[s.type], s.type)}${esc(s.type)} <span class="lock" aria-label="fixed">🔒</span></div>`
        : `<label class="slot-type">${s.type ? ico(TAG_ICONS[s.type], s.type) : ''}
          <select data-army-type="${i}" aria-label="Slot ${i} type">${fixed3 ? '' : '<option value="">Type…</option>'}${opts.map((o) => `<option ${o === s.type ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    const tierBtns = A.tiers.map((tt, k) => `<button class="tier-btn" style="--tc:${tt.color}" aria-pressed="${k === s.tier}" data-army-tier="${i}" data-tier="${k}" title="${tt.name}${tt.bonus ? ` +${tt.bonus}` : ''}">${tt.name[0]}</button>`).join('');
    const boostCtl = i === A.boostSlot
      ? `<button class="boost-btn" aria-pressed="${s.boost}" data-army-boost="${i}" title="The mini here plays at XP level 20">${s.boost ? '⚡ Boost' : '+ Boost'}</button>`
      : '';
    return `<div class="slot${isLeaderSlot ? ' leader-slot' : ''}${s.boost ? ' boosted' : ''}" style="--tc:${t.color}">
      ${typeCtl}
      <div class="slot-tier">${t.name}${t.bonus ? ` · +${t.bonus} level${t.bonus === 1 ? '' : 's'}` : ''}${s.boost ? ' · XP level 20' : ''}</div>
      <div class="tier-btns">${tierBtns}</div>
      ${boostCtl}
    </div>`;
  }).join('');
  const a = armyTotals([u]);
  return `<h3>Army slots</h3>
    <div class="army-grid">${cells}</div>
    <div class="small">${m.fixedArmySlots ? 'Top row fixed for this leader (the third can become Wildcard). ' : 'This leader\'s top row isn\'t known yet, so every slot is editable. '}Copy the tiers from the game's Army screen. Bronze to Gold come from Dungeons, Sieges and Raids; Gold to Diamond costs ${a.cost} ${curName('valor')}.</div>
    <div class="note">${a.notDiamond === 0
      ? `All ${a.slots} slots are Diamond.`
      : `${a.diamonds}/${a.slots} Diamond · ${a.goldReady} Gold slot${a.goldReady === 1 ? '' : 's'} ready · ${fmt(a.notDiamond * a.cost)} ${curName('valor')} to make this army all Diamond`}</div>`;
}

async function saveArmy(u, slots) {
  try {
    await post('/api/army', { account: state.account, unitId: u.id, slots });
    u.army = slots;
    await poll();
    renderDrawer();
  } catch (err) { alert(err.message); }
}

function renderDrawer() {
  const drawer = $('#drawer');
  const body = $('.drawer-body', drawer);
  let u = null;
  let m = null;
  if (ui.open.kind === 'unit') {
    u = state.units.find((x) => x.id === ui.open.id);
    if (!u) return closeDrawer();
    m = miniOf(u);
  } else {
    m = BY_SLUG.get(ui.open.slug);
  }
  const level = ui.previewLevel ?? (u && !u.synthetic ? Math.max(1, Math.min(totalLevel(u), RULES.maxLevel)) : 1);
  const parts = [];
  parts.push(`<button class="close" data-close aria-label="Close">×</button>`);
  parts.push(`<div class="drawer-head" style="--rc:${u ? rarityColor(u.rarity) : 'var(--line)'}">
    ${m ? `<img src="/static/${m.art}" alt="">` : '<div class="art unknown">?</div>'}
    <div><h2 id="drawerTitle">${esc(m ? m.name : unitName(u))}</h2>
    <div class="muted">${m ? `${m.category} · ${m.cost} gold` : 'Not identified yet'}</div>
    ${m ? `<div class="tags">${[m.family, ...String(m.role).split(',')].map(tag).join('')}</div>` : ''}
    ${u && !u.synthetic ? `<div class="muted">${rarityName(u.rarity)} · level ${totalLevel(u)}</div>` : ''}</div></div>`);

  if (u && !m) {
    parts.push(`<h3>Which mini is this?</h3><div class="row"><select data-name-unit="${u.id}">${miniOptions(null)}</select> <button class="btn" data-save-unit="${u.id}">Save</button></div>`);
  }
  if (m) parts.push(`<p class="desc">${esc(m.description)}</p>`);
  if (u?.synthetic) parts.push('<div class="note">Every player has this mini. It isn\'t stored in your save and has no levels, stars or talents to track.</div>');

  if (u && !u.synthetic) {
    const up = nextUpgrade(u);
    const slots = talentSlots(u);
    parts.push(`<h3>Progress</h3><dl class="kv">
      <dt>Level</dt><dd>${totalLevel(u)} = XP level ${u.xpLevel} + ${u.rarity} rarity + ${u.talents} talent${u.talents === 1 ? '' : 's'}${isLeader(u) ? ` + ${leaderSlotBonus(u)} Leader slot (${RULES.armySlots.tiers[armyOf(u)[RULES.armySlots.leaderSlot].tier].name})` : ''}</dd>
      <dt>XP</dt><dd>${u.xpLevel >= RULES.maxXpLevel ? 'Max XP level' : `${fmt(u.xp)} / ${fmt(u.xpNeeded)} · ${fmt(xpToMax(u))} XP to level 20`}</dd>
      <dt>Stars</dt><dd>${up ? `${u.stars} / ${up.stars}` : `${u.stars} (max rarity)`}</dd>
      <dt>Talent slots</dt><dd>${u.talents} bought of ${slots} unlocked${u.talents < slots ? ` · next costs ${RULES.talentCostCoins} ${curName('coins')} (have ${fmt(balance('coins'))})` : ''}</dd>
    </dl>`);
    if (up) {
      const c = (ok, txt) => `<span class="${ok ? 'cost-ok' : 'cost-no'}">${txt}</span>`;
      parts.push(`<h3>Next upgrade: ${rarityName(up.to)}</h3><div class="note">
        ${c(up.starsOk, `${up.stars} stars (have ${u.stars})`)} ·
        ${c(up.arcOk, `${fmt(up.arcEnergy)} ${curName('arcEnergy')} (have ${fmt(balance('arcEnergy'))})`)}
        ${up.core ? ` · ${c(up.coreOk, `1 ${coreName(up.core)} (have ${fmt(balance(up.core))})`)}` : ''}
        <br><b>${up.ready ? 'Ready to upgrade' : 'Not ready yet'}</b> · +1 level${(RULES.talentSlotsByRarity[up.to] ?? 0) > (RULES.talentSlotsByRarity[u.rarity] ?? 0) ? ` and talent slot ${RULES.talentSlotsByRarity[up.to]}` : ' (no new talent slot)'}</div>`);
    }
  }

  if (m && m.talents.length) {
    const picks = new Set(u ? effectivePicks(u) : []);
    const owned = u ? u.talents : 0;
    const auto = u && allTalentsOwned(u);
    let note = '';
    if (!u) note = '<div class="note">You don\'t own this mini (or it isn\'t identified yet).</div>';
    else if (auto) note = '<div class="note">You own every talent for this mini, so they\'re all ticked automatically.</div>';
    else if (owned === 0) note = `<div class="note">No talents bought yet. ${talentSlots(u) ? 'A slot is open - talents appear in the G.R.I.D.' : 'Upgrade to Uncommon to unlock the first slot.'}</div>`;
    else if (picks.size !== owned) note = `<div class="note warn">The game says you bought ${owned} talent${owned === 1 ? '' : 's'} for this mini. Tick which ${owned === 1 ? 'one' : 'ones'}.</div>`;
    parts.push(`<h3>Talents</h3>${note}` + m.talents.map((t, i) => {
      const checked = picks.has(i);
      const disabled = !u || auto || owned === 0 || (!checked && picks.size >= owned);
      return `<label class="talent ${checked ? 'picked' : ''}">
        <input type="checkbox" data-talent="${i}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <img src="/static/${m.talents[i].icon}" alt="">
        <div><b>${esc(t.name)}</b><div class="desc small">${esc(t.description)}</div></div></label>`;
    }).join(''));
  }

  if (m?.leaderAbility) parts.push(`<h3>Leader ability</h3><div class="trait"><div><b>${esc(m.leaderAbility.name)}</b><span class="desc">${esc(m.leaderAbility.description)}</span></div></div>`);
  if (u && isLeader(u)) parts.push(armyEditor(u, m));
  else if (m?.armySlotUpgrades?.length) parts.push(`<h3>Army slot types</h3><div class="tags">${m.armySlotUpgrades.map(tag).join('')}</div>`);
  if (m?.traits.length) parts.push(`<h3>Traits</h3>` + m.traits.map((t) => `<div class="trait">${ico(t.icon, t.name)}<div><b>${esc(t.name)}</b><span class="desc small">${esc(t.description)}</span></div></div>`).join(''));
  if (m) {
    parts.push(`<h3>Stats at level <span id="lvlOut">${level}</span></h3>
      <input type="range" min="1" max="${RULES.maxLevel}" value="${level}" data-level style="width:100%">
      <table class="stats-table">${statRows(m, level)}</table>
      ${m.weakAgainst ? `<div class="small">Weak against: ${esc(m.weakAgainst)}.</div>` : ''}`);
  }
  // keep the scroll position when re-rendering the same mini
  const key = JSON.stringify(ui.open);
  const keepScroll = body.dataset.key === key ? body.scrollTop : 0;
  body.innerHTML = parts.join('');
  body.dataset.key = key;
  body.scrollTop = keepScroll;
  body.style.setProperty('--rc', u ? rarityColor(u.rarity) : 'var(--line)');
  drawer.hidden = false;
}

function openDrawer(open) {
  ui.open = open;
  ui.previewLevel = null;
  renderDrawer();
}
function closeDrawer() {
  ui.open = null;
  delete $('.drawer-body').dataset.key;
  $('#drawer').hidden = true;
}

// ---- events ----------------------------------------------------------------------------
async function saveUnitName(id, select) {
  if (!select.value) return;
  try {
    await post('/api/name', { kind: 'unit', id, value: select.value });
    await poll();
  } catch (e) { alert(e.message); }
}

/**
 * Keeps the exe's app window at least as wide as the page's minimum width (capped at the screen width; not while
 * maximized). Browser tabs ignore resizeTo.
 */
function keepMinWidth() {
  if (!state?.standalone) return;
  const min = parseFloat(getComputedStyle(document.body).minWidth) || 0;
  const inside = document.documentElement.clientWidth; // excludes the scrollbar, like min-width
  if (!min || inside >= min) return;
  const maximized = window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight;
  if (maximized) return;
  const frame = window.outerWidth - inside; // borders and scrollbar
  const want = Math.min(Math.ceil(min + frame), screen.availWidth);
  if (want > window.outerWidth) window.resizeTo(want, window.outerHeight);
}

function bindStatic() {
  $('#account').addEventListener('change', (e) => { ui.account = e.target.value; store.set('account', ui.account); state = null; poll(); });
  $('#accountLabel').addEventListener('change', async (e) => {
    if (!state?.account) return;
    await post('/api/name', { kind: 'account', id: state.account, value: e.target.value });
    poll();
  });
  $('#show').addEventListener('change', (e) => { ui.show = e.target.value; store.set('show', ui.show); renderFilters(); renderGrid(); });
  $('#quitBtn').addEventListener('click', quitTracker);
  $('#dataBanner').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-releases]')) openExternal(RELEASES_URL);
  });
  const upd = $('#updateDialog');
  upd.addEventListener('click', (e) => {
    if (e.target.closest('[data-update-now]')) updateNow();
    if (e.target.closest('[data-update-later]')) updateLater();
  });
  // Esc: Later, unless it is busy
  upd.addEventListener('cancel', (e) => {
    e.preventDefault();
    const st = state?.update?.state;
    if (st !== 'downloading' && st !== 'restarting') updateLater();
  });
  // restore the minimum width after a resize
  let sizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(keepMinWidth, 250);
  });
  // external links open in the default browser when running in the exe
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target="_blank"][href^="https://"]');
    if (!a || !state?.standalone) return;
    e.preventDefault();
    openExternal(a.href);
  });

  // ---- backup menu ----
  const menu = $('#backupMenu');
  const setMenu = (open) => { menu.hidden = !open; $('#backupBtn').setAttribute('aria-expanded', String(open)); };
  $('#backupBtn').addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.backup')) setMenu(false); });
  menu.querySelector('a').addEventListener('click', () => setTimeout(() => setMenu(false), 0));
  $('#backupImport').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    setMenu(false);
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const when = backup.created ? new Date(backup.created).toLocaleString() : 'an unknown date';
      if (!confirm(`Restore the backup from ${when}?\n\nThis replaces your names, talents, army slots, saved armies and the army being edited.`)) return;
      const r = await post('/api/restore', { backup });
      ui.armyDraft = null; // reload the draft from the restored data
      state = null;
      await poll();
      alert(`Backup restored (${r.restored.join(', ')}).`);
    } catch (err) {
      alert(`Could not restore: ${err.message}`);
    }
  });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; store.set('sort', ui.sort); renderGrid(); });

  document.addEventListener('click', async (e) => {
    // close the trait picker on outside clicks
    if (ui.traitPickerOpen && !e.target.closest('#filters .trait-pop,[data-trait-picker]')) { ui.traitPickerOpen = false; renderFilters(); }
    const t = e.target.closest('[data-f-type],[data-f-family],[data-f-trait],[data-trait-picker],[data-trait-mode],[data-clear-traits],[data-clear-filters],[data-plan-cat],[data-plan-toggle],[data-open-unit],[data-open-mini],[data-save-unit],[data-close]');
    if (!t) return;
    if (t.hasAttribute('data-plan-toggle')) { ui.planExpanded = !ui.planExpanded; store.set('planExpanded', ui.planExpanded); renderPlanner(); return; }
    const refilter = () => { saveFilters(); renderFilters(); renderPlanner(); renderGrid(); };
    if (t.dataset.fType) { toggleIn(ui.filters.types, t.dataset.fType); refilter(); }
    else if (t.dataset.fFamily) { toggleIn(ui.filters.families, t.dataset.fFamily); refilter(); }
    else if (t.dataset.fTrait) { toggleIn(ui.filters.traits, t.dataset.fTrait); refilter(); }
    else if (t.hasAttribute('data-trait-picker')) { ui.traitPickerOpen = !ui.traitPickerOpen; ui.traitSearch = ''; renderFilters(); if (ui.traitPickerOpen) $('#filters .trait-search')?.focus(); }
    else if (t.dataset.traitMode) { ui.filters.traitMode = t.dataset.traitMode; refilter(); }
    else if (t.hasAttribute('data-clear-traits')) { ui.filters.traits = []; refilter(); }
    else if (t.hasAttribute('data-clear-filters')) { ui.filters = { types: [], families: [], traits: [], traitMode: ui.filters.traitMode }; ui.traitPickerOpen = false; refilter(); }
    else if (t.dataset.planCat) { ui.planCategory = t.dataset.planCat; store.set('planCategory', ui.planCategory); renderPlanner(); }
    else if (t.dataset.openUnit) openDrawer({ kind: 'unit', id: t.dataset.openUnit });
    else if (t.dataset.openMini) openDrawer({ kind: 'mini', slug: t.dataset.openMini });
    else if (t.dataset.saveUnit) saveUnitName(t.dataset.saveUnit, $(`[data-name-unit="${t.dataset.saveUnit}"]`, t.parentElement));
    else if (t.hasAttribute('data-close')) closeDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.open) closeDrawer();
    else if (ui.traitPickerOpen) { ui.traitPickerOpen = false; renderFilters(); }
  });

  // trait picker: search filters in place; checkboxes keep the picker open
  $('#filters').addEventListener('input', (e) => {
    if (!e.target.matches('.trait-search')) return;
    ui.traitSearch = e.target.value;
    applyTraitSearch();
  });
  $('#filters').addEventListener('change', (e) => {
    const name = e.target.dataset?.fTraitBox;
    if (!name) return;
    toggleIn(ui.filters.traits, name);
    saveFilters();
    const scroll = $('#filters .trait-list')?.scrollTop;
    renderFilters();
    renderPlanner();
    renderGrid();
    if ($('#filters .trait-list')) $('#filters .trait-list').scrollTop = scroll || 0;
  });

  $('.drawer-body').addEventListener('input', (e) => {
    if (!e.target.matches('[data-level]')) return;
    ui.previewLevel = Number(e.target.value);
    $('#lvlOut').textContent = ui.previewLevel;
    const u = ui.open.kind === 'unit' ? state.units.find((x) => x.id === ui.open.id) : null;
    const m = u ? miniOf(u) : BY_SLUG.get(ui.open.slug);
    $('.stats-table').innerHTML = statRows(m, ui.previewLevel);
  });

  // army slots: tier buttons and type selects
  $('.drawer-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-army-tier],[data-army-boost]');
    if (!b || ui.open?.kind !== 'unit') return;
    const u = state.units.find((x) => x.id === ui.open.id);
    const slots = armyOf(u);
    if (b.dataset.armyBoost) slots[Number(b.dataset.armyBoost)].boost = !slots[Number(b.dataset.armyBoost)].boost;
    else slots[Number(b.dataset.armyTier)].tier = Number(b.dataset.tier);
    saveArmy(u, slots);
  });
  $('.drawer-body').addEventListener('change', (e) => {
    if (!e.target.matches('[data-army-type]') || ui.open?.kind !== 'unit') return;
    const u = state.units.find((x) => x.id === ui.open.id);
    const slots = armyOf(u);
    slots[Number(e.target.dataset.armyType)].type = e.target.value;
    saveArmy(u, slots);
  });

  $('.drawer-body').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-talent]') || ui.open?.kind !== 'unit') return;
    const u = state.units.find((x) => x.id === ui.open.id);
    const picks = [...$('.drawer-body').querySelectorAll('[data-talent]:checked')].map((x) => Number(x.dataset.talent));
    try {
      await post('/api/talents', { account: state.account, unitId: u.id, picks });
      u.talentPicks = picks;
      await poll();
      renderDrawer();
    } catch (err) { alert(err.message); }
  });
}

// all page scripts have run by DOMContentLoaded
const pageScriptsLoaded = new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
  else resolve();
});
boot().catch((e) => { $('#status').textContent = `Failed to start: ${e.message}`; });
