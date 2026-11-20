// The page's entry module. It loads the game tables, polls the server's state, switches tabs and draws the header.
// Each tab is its own module, and core.js holds what they share.
import { renderArmory, bindArmory } from './armory.js';
import { renderArmy, bindArmy } from './army.js';
import { bindBackupMenu } from './backup.js';
import { renderCalendar, bindCalendar } from './calendar.js';
import { renderCurrencies, renderSummary, renderNeeds, renderPlanner, renderFilters, renderGrid, renderEvents,
  bindCollection } from './collection.js';
import { $, store, post, openExternal, RULES, ALWAYS_OWNED, state, dirty, setTables, setState, setDirty,
  resetTableCaches, ui } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { panel, renderDrawer, bindDrawer } from './drawer.js';
import { renderGridTab, bindGridTab } from './grid.js';
import { esc, ago } from './lib/format.js';
import { LIMITS } from './lib/limits.js';
import { renderProgress } from './progress.js';
import { renderPvp, bindPvp } from './pvp.js';
import { renderReportBadge, bindReport } from './report.js';
import { bindSettings } from './settings.js';
import { renderDataBanner, renderUpdate, bindUpdate } from './update.js';

async function quitTracker() {
  if (!(await confirmDialog('The tracker stops reading your game and sending notifications until you start ' +
    'RumbleTracker.exe again.', { title: 'Quit the tracker?', ok: 'Quit', danger: true }))) return;
  try { await post('/api/quit', {}); } catch { /* already gone */ }
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker has stopped</h1>'
    + '<p>You can close this window. Start RumbleTracker.exe to open it again.</p></main>';
  setTimeout(() => window.close(), 300);
}

async function loadTables() {
  const [rules, minis] = await Promise.all([
    fetch('/static/rules.json').then((r) => r.json()),
    fetch('/static/minis.json').then((r) => r.json()),
  ]);
  setTables(rules, minis);
}

/** After a data-pack update, loads the game tables again. The tabs reload theirs when next needed. */
async function reloadTables() {
  try {
    await loadTables();
    resetTableCaches();
  } catch { /* keep the old tables; tried again at the next change */ }
}

async function boot() {
  await loadTables();
  $('#accountLabel').maxLength = LIMITS.accountName;
  bindHeader();
  bindBackupMenu();
  bindUpdate();
  bindCollection();
  bindDrawer();
  bindArmy();
  bindArmory();
  bindCalendar();
  bindGridTab();
  bindPvp();
  bindSettings();
  bindReport();
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  setTab(ui.tab);
  await poll();
  schedulePoll();
  // back in view: refresh at once instead of waiting for the slow poll
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); schedulePoll(); } });
  setInterval(renderStatus, 1000);
}

// The page asks for the state every 5 seconds, every 60 seconds while its window is minimized or hidden, and every
// second while an update downloads, so the progress bar moves.
const POLL_MS = 5000, POLL_HIDDEN_MS = 60000, POLL_UPDATE_MS = 1000;
let pollTimer = null;
export function schedulePoll() {
  clearTimeout(pollTimer);
  const ms = state?.update?.state === 'downloading' ? POLL_UPDATE_MS : document.hidden ? POLL_HIDDEN_MS : POLL_MS;
  pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, ms);
}

// state that changes without a new revision (the server's liveState)
const LIVE_FIELDS = ['lastScan', 'lastError', 'problems', 'gameRunning', 'update'];

export async function poll() {
  try {
    const q = new URLSearchParams();
    if (ui.account) q.set('account', ui.account);
    // given the revision the page has, the server answers an unchanged state with the live fields only
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
    // after an update the tracker is a new version, so load its page
    if (state?.appVersion && s.appVersion && s.appVersion !== state.appVersion) { location.reload(); return; }
    // a data pack brought new game data, so reload the tables before drawing
    const dataVersion = s.dataStatus?.dataVersion || null;
    if (state && dataVersion !== state.dataStatus?.dataVersion) await reloadTables();
    for (const m of ALWAYS_OWNED) {
      if (s.account && !s.units.some((u) => u.slug === m.slug)) {
        s.units.push({ id: `always-${m.slug}`, slug: m.slug, synthetic: true, level: 0, xp: 0, xpNeeded: 0,
          xpLevel: RULES.maxXpLevel, bonus: 0, talents: 0, rarity: 0, stars: 0, talentPicks: [] });
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
function requestRender() {
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && !a.closest('.drawer-body') && a.id !== 'show' && a.id !== 'sort') {
    setDirty(true);
    return;
  }
  setDirty(false);
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (dirty) requestRender(); }, 0));

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
  if (panel.open) renderDrawer();
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
  sel.innerHTML = state.accounts.map((a) => `<option value="${a.id}"
    ${a.id === state.account ? 'selected' : ''}>${esc(a.label)} (${a.units} minis)</option>`).join('');
  if (!state.accounts.length) sel.innerHTML = '<option>No Rumble data found on this PC</option>';
  const current = state.accounts.find((a) => a.id === state.account);
  const input = $('#accountLabel');
  if (document.activeElement !== input) input.value = current && !current.label.startsWith('Account …') ? current.label : '';
}

/**
 * Keeps the exe's app window at least as wide as the page's minimum width, up to the screen width and not while
 * maximized. Browser tabs ignore resizeTo.
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

function bindHeader() {
  $('#account').addEventListener('change', (e) => {
    ui.account = e.target.value;
    store.set('account', ui.account);
    setState(null);
    poll();
  });
  $('#accountLabel').addEventListener('change', async (e) => {
    if (!state?.account) return;
    try {
      await post('/api/name', { kind: 'account', id: state.account, value: e.target.value });
    } catch (err) {
      alertDialog(err.message, { title: 'Not saved' });
    }
    poll();
  });
  $('#quitBtn').addEventListener('click', quitTracker);
  let sizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(keepMinWidth, 250);
  });
  // in the exe, outside links open in the default browser
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target="_blank"][href^="https://"]');
    if (!a || !state?.standalone) return;
    e.preventDefault();
    openExternal(a.href);
  });
}

boot().catch((e) => { $('#status').textContent = `The page could not start. ${e.message}`; });
