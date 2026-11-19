// G.R.I.D. tab: the current grid, its refresh timer and offer cooldowns.
// A mini is not re-offered until a number of other minis have been offered (12; 16 for leaders; 20 for special
// leaders). Cooldowns are derived from the grids the tracker has observed (data/grid_history.json).
import { currencyChip } from './collection.js';
import { $, esc, fmt, MINIS, BY_SLUG, state, ui, GRID_CURRENCY_IDS, onTablesReload } from './core.js';

export let STORE = null; // static/store.json
onTablesReload(() => { STORE = null; });
export async function loadStore() {
  if (!STORE) STORE = await fetch('/static/store.json').then((r) => r.json());
  return STORE;
}

export function countdown(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
export const rarityLabel = (id) => {
  const n = STORE.gridRarity[id]?.name || '';
  const m = /^(\w+?)Rarity_(Troop|Leader)$/.exec(n);
  return m ? `${m[1]}${m[2] === 'Leader' ? ' leader' : ''}` : '';
};
export const isLeaderSlug = (slug) => BY_SLUG.get(slug)?.category === 'Leader';
export const ownedSlug = (slug) => state.units.find((u) => u.slug === slug && !u.synthetic) || null;

/** Minis on cooldown: slug -> { place, limit, lastSeen }. */
export function gridCooldowns() {
  const rules = STORE.rules?.recentlySeen || {};
  const special = new Set((STORE.rules?.specialMinis || []).map((id) => state.gridHistory.flatMap((g) => g.items).find((x) => x.mini === id)?.slug).filter(Boolean));
  // Newest grid first. Minis in the same grid count as offered together; place = distinct minis of the same kind
  // offered in newer grids.
  const out = new Map();
  const seen = new Set();
  const counters = { mini: 0, leader: 0 };
  for (const g of [...state.gridHistory].reverse()) {
    const fresh = g.items.filter((x) => x.slug && !seen.has(x.slug));
    for (const x of fresh) {
      seen.add(x.slug);
      const leader = isLeaderSlug(x.slug);
      const kind = leader ? 'leader' : 'mini';
      const limit = special.has(x.slug) ? rules.m_superSpecialAwesomeMini || 20 : leader ? rules.m_leader || 16 : rules.m_mini || 12;
      const place = counters[kind];
      if (place < limit) out.set(x.slug, { place, limit, lastSeen: g.seen, leader });
    }
    for (const x of fresh) counters[isLeaderSlug(x.slug) ? 'leader' : 'mini']++;
  }
  return out;
}

export function gridSlot(s) {
  if (s.bought) return '<div class="grid-slot bought"><span>Bought</span></div>';
  if (s.xpBoost) {
    const x = STORE.xpBoosts[s.xpBoost] || {};
    return `<div class="grid-slot xp"><div class="grid-art xp-art">${x.icon ? `<img src="/static/store/${encodeURIComponent(x.icon)}.webp" alt="">` : 'XP'}</div><div class="grid-name">${esc((x.name || 'XP Boost').replace(/!$/, ''))}</div>
      <div class="grid-price">${x.coins != null ? `${fmt(x.coins)} <span class="gold">●</span>` : ''}</div></div>`;
  }
  const m = BY_SLUG.get(s.slug);
  const own = ownedSlug(s.slug);
  const price = STORE.gridRarity[s.rarity]?.coins;
  return `<div class="grid-slot${m ? '' : ' unknown'}" style="--rc:var(--r${Math.max(0, ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'].indexOf(rarityLabel(s.rarity).split(' ')[0]))})">
    <div class="grid-art">${m ? `<img src="/static/${m.art}" alt="">` : '?'}</div>
    <div class="grid-name">${esc(m?.name || 'New mini (not in the tracker\'s data yet)')}</div>
    <div class="grid-meta">${esc(rarityLabel(s.rarity))}${own ? ` · <span class="cost-ok">Lvl ${own.level}</span>` : m ? ' · <span class="cost-no">not owned</span>' : ''}</div>
    <div class="grid-price">${price != null ? `${fmt(price)} <span class="gold">●</span>` : ''}</div>
  </div>`;
}

// (renderGrid is the Collection grid, collection.js)
export async function renderGridTab() {
  const page = $('#tab-grid');
  if (!page || !state) return;
  try { await loadStore(); } catch { page.innerHTML = '<div class="panel muted">Could not load static/store.json.</div>'; return; }
  if (ui.tab !== 'grid') return;
  const shop = state.shop;
  if (!shop) { page.innerHTML = '<div class="panel muted">No G.R.I.D. in the saved data for this account yet. Open the shop in the game.</div>'; return; }
  // G.R.I.D. currencies (GRID_CURRENCY_IDS, core.js) the account has
  const gridCur = GRID_CURRENCY_IDS.map((id) => state.currencies.find((c) => c.id === id && c.name)).filter(Boolean);
  const cd = gridCooldowns();
  const hist = state.gridHistory || [];
  const since = hist[0]?.seen;
  const cooling = [...cd.entries()].sort((a, b) => a[1].place - b[1].place);
  const chip = ([slug, c]) => {
    const m = BY_SLUG.get(slug);
    const left = c.limit - c.place;
    return `<span class="cd-chip${ownedSlug(slug) ? '' : ' not-owned'}" title="Last offered ${esc(new Date(c.lastSeen).toLocaleString())} · back after ${left} more ${c.leader ? 'leaders' : 'minis'}">
      ${m ? `<img src="/static/${m.art}" alt="">` : ''}<span>${esc(m?.name || slug)}</span><b>${left}</b></span>`;
  };
  const eligible = MINIS.filter((m) => !m.alwaysOwned && !cd.has(m.slug));
  page.innerHTML = `
    <section class="panel grid-head">
      <h2>G.R.I.D.</h2>
      <span class="grid-timer">${shop.grid.refresh && Date.parse(shop.grid.refresh) <= Date.now()
        ? 'Refreshing now <span class="muted small">— open the shop in the game</span>'
        : `Refreshes in <b>${esc(countdown(shop.grid.refresh))}</b>`}</span>
      <span class="muted small">${shop.grid.refresh ? esc(new Date(shop.grid.refresh).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : ''} · every ${Math.round((STORE.rules?.refreshSeconds || 86400) / 3600)} h</span>
      ${gridCur.length ? `<div class="currencies grid-currencies">${gridCur.map(currencyChip).join('')}</div>` : ''}
    </section>
    <div class="grid-layout">
      <section class="panel"><div class="grid-board">${shop.grid.rows.map((row) => row.map(gridSlot).join('')).join('')}</div></section>
      <section class="panel grid-cd">
        <h2>On cooldown <span class="muted small">${cooling.length} minis</span></h2>
        <p class="muted small">A mini comes back only after ${STORE.rules?.recentlySeen?.m_mini || 12} other minis have been offered
          (leaders ${STORE.rules?.recentlySeen?.m_leader || 16}; Malfurion, Anub'arak, Doomhammer and Arthas ${STORE.rules?.recentlySeen?.m_superSpecialAwesomeMini || 20}).
          The number is how many are still to go, at most. Based on ${hist.length} grid${hist.length === 1 ? '' : 's'} seen${since ? ` since ${esc(new Date(since).toLocaleDateString())}` : ''},
          so the list may be incomplete at first.</p>
        <div class="cd-list">${cooling.length ? cooling.map(chip).join('') : '<span class="muted">Nothing logged yet.</span>'}</div>
        <details class="cd-eligible"><summary>Can be offered: ${eligible.length} minis</summary>
          <div class="cd-list">${eligible.sort((a, b) => a.name.localeCompare(b.name)).map((m) => `<span class="cd-chip small${ownedSlug(m.slug) ? '' : ' not-owned'}" title="${esc(m.name)}"><img src="/static/${m.art}" alt=""><span>${esc(m.name)}</span></span>`).join('')}</div>
        </details>
      </section>
    </div>
    <section class="panel grid-hist">
      <h2>Grids seen <span class="muted small">newest first</span></h2>
      ${hist.length ? `<ol>${[...hist].reverse().slice(0, 30).map((g) => `<li><span class="muted small">${esc(new Date(g.seen).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        <span class="hist-items">${g.items.map((x) => { const m = x.slug && BY_SLUG.get(x.slug); if (m) return `<img src="/static/${m.art}" alt="" title="${esc(m.name)}">`;
          const xb = STORE.xpBoosts[x.xpBoost];
          return xb?.icon ? `<img class="hist-xp-img" src="/static/store/${encodeURIComponent(xb.icon)}.webp" alt="" title="${esc(xb.name)}">` : `<span class="hist-xp" title="${esc(xb?.name || 'XP boost')}">XP</span>`; }).join('')}</span></li>`).join('')}</ol>` : '<p class="muted">The tracker logs each new grid it sees.</p>'}
    </section>`;
}

export function bindGridTab() {
  setInterval(() => { if (ui.tab === 'grid' && !document.hidden) renderGridTab(); }, 30000);
}
