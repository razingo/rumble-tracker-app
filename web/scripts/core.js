// Shared state and helpers for every page module: the game tables, the server's state, the UI settings and small
// formatting and request helpers. Imports nothing, so any module can use it.
// ---- helpers -----------------------------------------------------------------
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n);
// the page's local settings (through window: none in tests)
export const store = {
  get(k, d) { try { const v = globalThis.window?.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { globalThis.window?.localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
export function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}
export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Opens an external link; in the exe's app window it is passed to the default browser via the server. */
export async function openExternal(url) {
  if (state?.standalone) {
    try { await post('/api/open-external', { url }); return; } catch { /* fall back to a window here */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ---- state ---------------------------------------------------------------------
// Assigned only here (setTables, setState, setDirty): other modules see the current values through their imports.
export let RULES, MINIS, BY_SLUG, TAG_ICONS;
export let ALWAYS_OWNED = []; // minis every player owns (not in the save; no progress)
export let state = null; // the server's state for the selected account (/api/state)
export let dirty = false; // a redraw waits until the user leaves a field

/** rules.json and minis.json. */
export function setTables(rules, minisFile) {
  RULES = rules;
  MINIS = minisFile.minis;
  // Wildcard and Leader icons are not in minis.json
  TAG_ICONS = { Wildcard: 'icons/Wildcard.png', Leader: 'icons/Leader.png', ...(minisFile.tagIcons || {}) };
  ALWAYS_OWNED = MINIS.filter((m) => m.alwaysOwned);
  BY_SLUG = new Map(MINIS.map((m) => [m.slug, m]));
}
export const setState = (s) => { state = s; };
export const setDirty = (d) => { dirty = d; };

// Tabs keep the game tables they load; after a data-pack update they are dropped and loaded again when needed.
const tableResets = [];
export const onTablesReload = (fn) => { tableResets.push(fn); };
export const resetTableCaches = () => { for (const fn of tableResets) fn(); };
export const ui = {
  account: store.get('account', null),
  category: store.get('category', 'all'),
  show: store.get('show', 'owned'),
  sort: store.get('sort', 'level'),
  planCategory: store.get('planCategory', 'all'),
  planExpanded: store.get('planExpanded', false),
  // the address's #tab, else the last one (no location in tests)
  tab: ((h) => (['collection', 'army', 'armory', 'grid', 'calendar', 'pvp', 'progress'].includes(h) ? h : store.get('tab', 'collection')))(globalThis.location?.hash.slice(1)),
  filters: { types: [], families: [], traits: [], traitMode: 'all', ...store.get('filters', {}) },
  traitPickerOpen: false,
  traitSearch: '',
  open: null, // { kind: 'unit', id } | { kind: 'mini', slug }
  previewLevel: null,
};

export const CATEGORIES = [['all', 'All'], ['Unit', 'Units'], ['Leader', 'Leaders'], ['Spell', 'Spells'], ['unknown', 'New / unknown']];

export const RELEASES_URL = 'https://github.com/razingo/rumble-tracker-app/releases/latest';

// G.R.I.D. currencies, shown on the G.R.I.D. tab instead of the Collection (save IDs).
export const GRID_CURRENCY_IDS = [
  '44b7dad7dfaa4aae8eb69b8dbf6968b8', // Big Red Buttons
  'e1f4dd57cf836abed7875b0b33bb87e8', // Rare-O-Matics
  '38547868a0830bd6fa60ffc4440983a8', // Modest Tinker's Gems
  '74c4595e80588d652ab5bc38691b79c9', // Major Tinker's Gems
  '97b4103c5c0740da8488d67801c30c2b', // Mega Tinker's Gems
];

// Ankh ("used to continue failed dungeons"), shown on the Calendar's Dungeon card instead of the Collection.
export const ANKH_ID = '32141a9ef28487c729b80616d70185ba';
