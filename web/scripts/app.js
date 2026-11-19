// The page's entry module: loads the game tables, polls the server's state (/api/state), switches tabs and draws the
// header (accounts, status, Quit). Each tab is its own module; shared state is in core.js.
import { confirmDialog, alertDialog } from './dialogs.js';
import { renderArmory, bindArmory } from './armory.js';
import { renderArmy, bindArmy } from './army.js';
import { when, renderCalendar, bindCalendar } from './calendar.js';
import { renderCurrencies, renderSummary, renderNeeds, renderPlanner, saveFilters, toggleIn, renderFilters, applyTraitSearch, renderGrid, renderEvents } from './collection.js';
import { $, esc, store, ago, post, openExternal, RULES, BY_SLUG, ALWAYS_OWNED, state, dirty, ui, RELEASES_URL, setTables, setState, setDirty, resetTableCaches } from './core.js';
import { statRows, saveArmy, renderDrawer, openDrawer, closeDrawer, saveUnitName } from './drawer.js';
import { renderGridTab, bindGridTab } from './grid.js';
import { bindNotify } from './notifications.js';
import { renderProgress } from './progress.js';
import { renderPvp, bindPvp } from './pvp.js';
import { renderReportBadge, bindReport } from './report.js';
import { miniOf, armyOf } from './units.js';
import { renderDataBanner, renderUpdate, updateNow, updateLater } from './update.js';

/** Asks, then restores a backup with restore() (a request); what: "the backup from …". */
export async function restoreBackup(what, restore) {
  if (!(await confirmDialog(`This replaces what you entered (names, talents, army slots, armies, goals and settings) and the G.R.I.D., PvP and progress history with ${what}.`, { title: 'Restore this backup?', ok: 'Restore' }))) return;
  try {
    const r = await restore();
    ui.armyDraft = null; // load the draft from the restored data
    setState(null);
    await poll();
    const LABELS = {
      names: 'names', talents: 'talents', army: 'army slots', armies: 'saved armies', drafts: 'the army being edited',
      learned: 'learned game values', grid_history: 'G.R.I.D. history', pvp_history: 'PvP history',
      notifications: 'notification settings', plans: 'reward goals', progress: 'progress history',
    };
    alertDialog(`Restored: ${r.restored.map((k) => LABELS[k] || k).join(', ')}.`, { title: 'Backup restored' });
  } catch (err) {
    alertDialog(err.message, { title: 'Not restored' });
  }
}

/** The automatic backups in the Backup menu. */
async function renderBackupList() {
  const el = $('#backupList');
  try {
    const { backups } = await fetch('/api/backups').then((r) => r.json());
    const today = new Date().toLocaleDateString('sv-SE');
    const label = (day) => (day === today ? 'today' : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
    el.innerHTML = backups.length
      ? backups.map((b) => `<button role="menuitem" data-backup-day="${esc(b.day)}" data-label="${esc(label(b.day))}" title="Saved ${esc(new Date(b.created).toLocaleString())}">Restore ${esc(label(b.day))}</button>`).join('')
      : '<p class="small muted">None yet: one is saved when the tracker starts, every 24 hours and when it stops.</p>';
  } catch { el.innerHTML = '<p class="small muted">Not available.</p>'; }
}

export async function quitTracker() {
  if (!(await confirmDialog('The tracker stops reading your game and sending notifications until you start RumbleTracker.exe again.', { title: 'Quit the tracker?', ok: 'Quit', danger: true }))) return;
  try { await post('/api/quit', {}); } catch { /* already gone */ }
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker has stopped</h1><p>You can close this window. Start RumbleTracker.exe to open it again.</p></main>';
  setTimeout(() => window.close(), 300);
}

// ---- data loading ----------------------------------------------------------------
export async function loadTables() {
  const [rules, minis] = await Promise.all([
    fetch('/static/rules.json').then((r) => r.json()),
    fetch('/static/minis.json').then((r) => r.json()),
  ]);
  setTables(rules, minis);
}

/** After a data-pack update: reloads every game table (the tab scripts load theirs again when next needed). */
export async function reloadTables() {
  try {
    await loadTables();
    resetTableCaches();
  } catch { /* keep the old tables; tried again at the next change */ }
}

export async function boot() {
  await loadTables();
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
  schedulePoll();
  // back in view: refresh at once instead of waiting for the slow poll
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); schedulePoll(); } });
  setInterval(renderStatus, 1000);
}

// Polling: every 5 s; every 60 s while the tracker's window is minimized or hidden; every second while an update
// downloads (for its progress).
export const POLL_MS = 5000, POLL_HIDDEN_MS = 60000, POLL_UPDATE_MS = 1000;
export let pollTimer = null;
export function schedulePoll() {
  clearTimeout(pollTimer);
  const ms = state?.update?.state === 'downloading' ? POLL_UPDATE_MS : document.hidden ? POLL_HIDDEN_MS : POLL_MS;
  pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, ms);
}

// state fields that change without a new revision (the server's liveState)
export const LIVE_FIELDS = ['lastScan', 'lastError', 'problems', 'gameRunning', 'update'];

export async function poll() {
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
    setState(s);
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
export function requestRender() {
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && !a.closest('.drawer-body') && a.id !== 'show' && a.id !== 'sort') {
    setDirty(true);
    return;
  }
  setDirty(false);
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (dirty) requestRender(); }, 0));

// ---- rendering ------------------------------------------------------------------------
export function setTab(tab) {
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

export function render() {
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

export function renderStatus() {
  const el = $('#status');
  if (!state) return;
  const err = state.connError || state.lastError;
  const live = state.gameRunning === false ? `Game closed · last read ${ago(state.lastScan)}` : `Live · last scan ${ago(state.lastScan)}`;
  el.className = `status${err ? ' error' : state.gameRunning === false ? ' idle' : ''}`;
  el.innerHTML = `<span class="dot"></span><span class="status-text">${err ? esc(err) : live}</span>`;
}

export function renderAccounts() {
  const sel = $('#account');
  sel.innerHTML = state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.account ? 'selected' : ''}>${esc(a.label)} (${a.units} minis)</option>`).join('');
  if (!state.accounts.length) sel.innerHTML = '<option>No Rumble data found on this PC</option>';
  const current = state.accounts.find((a) => a.id === state.account);
  const input = $('#accountLabel');
  if (document.activeElement !== input) input.value = current && !current.label.startsWith('Account …') ? current.label : '';
}

/**
 * Keeps the exe's app window at least as wide as the page's minimum width (capped at the screen width; not while
 * maximized). Browser tabs ignore resizeTo.
 */
export function keepMinWidth() {
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

export function bindStatic() {
  $('#account').addEventListener('change', (e) => { ui.account = e.target.value; store.set('account', ui.account); setState(null); poll(); });
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
  const setMenu = (open) => {
    menu.hidden = !open;
    $('#backupBtn').setAttribute('aria-expanded', String(open));
    if (open) renderBackupList();
  };
  $('#backupBtn').addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.backup')) setMenu(false); });
  menu.querySelector('a').addEventListener('click', () => setTimeout(() => setMenu(false), 0));
  $('#backupImport').addEventListener('click', () => $('#backupFile').click());
  // an automatic backup
  $('#backupList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-backup-day]');
    if (!b) return;
    setMenu(false);
    await restoreBackup(`the automatic backup from ${b.dataset.label}`, () => post('/api/backups/restore', { day: b.dataset.backupDay }));
  });
  $('#backupFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    setMenu(false);
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const when = backup.created ? new Date(backup.created).toLocaleString() : 'an unknown date';
      await restoreBackup(`the backup from ${when}`, () => post('/api/restore', { backup }));
    } catch (err) {
      alertDialog(`Could not read the file: ${err.message}`, { title: 'Not restored' });
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
    } catch (err) { alertDialog(err.message, { title: 'Not saved' }); }
  });
}

boot().catch((e) => { $('#status').textContent = `Failed to start: ${e.message}`; });
