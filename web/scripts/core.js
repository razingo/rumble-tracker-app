// What every page module shares: the game tables, the server's state, the selected account and tab, and request
// helpers. It imports nothing, so any module can use it.
export const $ = (s, el = document) => el.querySelector(s);
// the page's settings in local storage, reached through window, which tests don't have
export const store = {
  get(k, d) { try { const v = globalThis.window?.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { globalThis.window?.localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Opens an outside link. The exe's app window has the server open it in the default browser. */
export async function openExternal(url) {
  if (state?.standalone) {
    try { await post('/api/open-external', { url }); return; } catch { /* fall back to a window here */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Only this module assigns these (setTables, setState, setDirty); the other modules see the current values.
export let RULES, MINIS, BY_SLUG, TAG_ICONS;
export let ALWAYS_OWNED = []; // minis every player owns, which the save doesn't list
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

// Tabs keep the game tables they load. After a data-pack update those are dropped and loaded again when needed.
const tableResets = [];
export const onTablesReload = (fn) => { tableResets.push(fn); };
export const resetTableCaches = () => { for (const fn of tableResets) fn(); };
// The selected account and tab, kept between visits; each tab keeps its own state.
export const ui = {
  account: store.get('account', null),
  // the address's #tab, else the last one (tests have no location)
  tab: ((h) => (['collection', 'army', 'armory', 'grid', 'calendar', 'pvp', 'progress'].includes(h)
    ? h : store.get('tab', 'collection')))(globalThis.location?.hash.slice(1)),
};

export const RELEASES_URL = 'https://github.com/razingo/rumble-tracker-app/releases/latest';

// The G.R.I.D. currencies, shown on the G.R.I.D. tab instead of the Collection.
export const GRID_CURRENCY_IDS = [
  '44b7dad7dfaa4aae8eb69b8dbf6968b8', // Big Red Buttons
  'e1f4dd57cf836abed7875b0b33bb87e8', // Rare-O-Matics
  '38547868a0830bd6fa60ffc4440983a8', // Modest Tinker's Gems
  '74c4595e80588d652ab5bc38691b79c9', // Major Tinker's Gems
  '97b4103c5c0740da8488d67801c30c2b', // Mega Tinker's Gems
];

// The Ankh, which continues a failed dungeon, shown on the Calendar's Dungeon card instead of the Collection.
export const ANKH_ID = '32141a9ef28487c729b80616d70185ba';
