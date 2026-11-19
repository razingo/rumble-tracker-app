// Collection tab: currencies, summary, what's needed next, the upgrade planner, filters, the mini grid and recent
// changes.
import { familiesOf } from './army.js';
import { when } from './calendar.js';
import { $, esc, fmt, store, ago, RULES, MINIS, TAG_ICONS, state, ui, GRID_CURRENCY_IDS, ANKH_ID } from './core.js';
import { ico } from './drawer.js';
import { rarityName, rarityColor, miniOf, unitName, balance, curName, coreName, nextUpgrade, talentSlots, effectivePicks, isLeader, armyOf, hasBoost, totalLevel, armyTotals, remainingToLegendary } from './units.js';

/** Currency chip: icon, name and balance; lifetime total as tooltip. */
export function currencyChip(c) {
  const icon = RULES.currencyIcons?.[c.id];
  return `<div class="cur" title="${esc(c.name)} · earned all time: ${fmt(c.lifetime)}">${icon ? `<img class="cur-ico" src="/static/${icon}" alt="">` : ''}<span>${esc(c.name)}</span><b>${fmt(c.balance)}</b></div>`;
}

export function renderCurrencies() {
  // event tickets, Ankh and G.R.I.D. currencies are on other tabs
  const named = state.currencies.filter((c) => c.name && !c.slot && !GRID_CURRENCY_IDS.includes(c.id) && c.id !== ANKH_ID);
  const order = ['coins', 'arcEnergy', 'rareCore', 'epicCore', 'legendaryCore', 'valor'].map((r) => RULES.currencyIds[r]);
  named.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  $('#currencies').innerHTML = named.map(currencyChip).join('');
}

export function renderSummary() {
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

export function lastEventFor(id) {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].id === id) return state.events[i];
  return null;
}

export function miniOptions(currentSlug) {
  const taken = new Set(state.units.map((u) => u.slug).filter(Boolean));
  const groups = { Unit: [], Leader: [], Spell: [] };
  for (const m of MINIS) if (!taken.has(m.slug) || m.slug === currentSlug) groups[m.category].push(m);
  return '<option value="">Choose a mini…</option>' + Object.entries(groups)
    .map(([g, list]) => `<optgroup label="${g}s">${list.map((m) => `<option value="${m.slug}">${esc(m.name)}</option>`).join('')}</optgroup>`)
    .join('');
}

export function renderNeeds() {
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
export const PLAN_SIZE = 8;

export function planArt(u) {
  const m = miniOf(u);
  return m ? `<img src="/static/${m.art}" alt="" loading="lazy">` : '<div class="art unknown">?</div>';
}

export function planRow(u, pct, label, togo, togoUnit, extra = '') {
  return `<button class="plan-row" style="--rc:${rarityColor(u.rarity)}" data-open-unit="${u.id}">
    ${planArt(u)}
    <div><b>${esc(unitName(u))}</b> <span class="small">${esc(label)}</span>
      <div class="bar${togoUnit === 'stars' ? ' stars' : ''}"><span style="width:${pct}%"></span></div>${extra}</div>
    <div class="togo">${fmt(togo)}<small>${togoUnit} to go</small></div>
  </button>`;
}

export function renderPlanner() {
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
export const TYPES = [['Unit', 'Units'], ['Leader', 'Leaders'], ['Spell', 'Spells'], ['unknown', 'New / unknown']];
export const FAMILIES = ['Alliance', 'Horde', 'Undead', 'Beast', 'Blackrock', 'Cenarion'];

export function allTraits() {
  const map = new Map();
  for (const m of MINIS) for (const t of m.traits) if (!map.has(t.name)) map.set(t.name, t);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a mini (null: unidentified) passes the filters; `skip` ignores one group, for facet counts. */
export function passes(m, skip) {
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
export function gridPool() {
  const pool = state.units.map((u) => ({ unit: u, mini: miniOf(u) }));
  if (ui.show === 'all') {
    const owned = new Set(state.units.map((u) => u.slug));
    for (const m of MINIS) if (!owned.has(m.slug)) pool.push({ unit: null, mini: m });
  }
  return pool;
}

export const filtersActive = () => ui.filters.types.length + ui.filters.families.length + ui.filters.traits.length > 0;

export function saveFilters() { store.set('filters', ui.filters); }

export function toggleIn(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1); else list.push(value);
}

export function renderFilters() {
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

export function applyTraitSearch() {
  const q = ui.traitSearch.trim().toLowerCase();
  for (const el of document.querySelectorAll('#filters .trait-opt')) el.hidden = !!q && !el.dataset.traitName.includes(q);
}

/** Card frame class for the mini's family (theme-art.css). */
export const frameCls = (m) => `frame-${String(m?.family || 'neutral').toLowerCase()}`;

export function cardForUnit(u) {
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

export function armyStrip(u) {
  const tiers = RULES.armySlots.tiers;
  const cells = armyOf(u).map((s) => {
    const t = tiers[s.tier];
    return `<span class="army-cell${s.type === 'Wildcard' ? ' wild' : ''}${s.boost ? ' boost' : ''}" style="--tc:${t.color}" title="${esc(s.type || 'Type not set')}: ${t.name}${t.bonus ? ` (+${t.bonus})` : ''}${s.boost ? ' · Boost' : ''}"></span>`;
  }).join('');
  return `<div class="army-strip" aria-label="Army slots">${cells}</div>`;
}

export function cardForMissing(m) {
  return `<button class="card missing ${frameCls(m)}" data-open-mini="${m.slug}">
    <img class="art" src="/static/${m.art}" alt="" loading="lazy">
    <div class="name">${esc(m.name)}</div>
    <div class="meta">${m.category} · ${esc(m.family)}</div>
    <div class="small">Not owned${state.units.some((u) => !u.slug) ? ' or not identified yet' : ''}</div>
  </button>`;
}

export function sortUnits(list) {
  const by = {
    level: (a, b) => totalLevel(b) - totalLevel(a) || unitName(a).localeCompare(unitName(b)),
    name: (a, b) => unitName(a).localeCompare(unitName(b)),
    rarity: (a, b) => b.rarity - a.rarity || totalLevel(b) - totalLevel(a),
    ready: (a, b) => (nextUpgrade(b)?.ready ? 1 : 0) - (nextUpgrade(a)?.ready ? 1 : 0) || totalLevel(b) - totalLevel(a),
  }[ui.sort];
  return [...list].sort(by);
}

export function renderGrid() {
  const pool = gridPool().filter(({ mini }) => passes(mini));
  const units = sortUnits(pool.filter((p) => p.unit).map((p) => p.unit));
  const missing = pool.filter((p) => !p.unit).map((p) => p.mini).sort((a, b) => a.name.localeCompare(b.name));
  const html = units.map(cardForUnit).join('') + missing.map(cardForMissing).join('');
  const total = state.units.length + (ui.show === 'all' ? MINIS.length - new Set(state.units.map((u) => u.slug).filter(Boolean)).size : 0);
  $('#gridCount').textContent = filtersActive() ? `Showing ${units.length + missing.length} of ${total}` : `${total} minis`;
  $('#grid').innerHTML = html || '<p class="muted">No minis match these filters.</p>';
}

export function eventText(e) {
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

export function renderEvents() {
  const list = state.events.slice(-25).reverse(); // latest 25
  $('#eventsCount').textContent = list.length ? `· latest ${list.length}` : '';
  $('#events').innerHTML = list.length
    ? list.map((e) => `<li><time>${ago(e.t)}</time>${esc(eventText(e))}</li>`).join('')
    : '<li class="muted">No changes yet. Play a battle or upgrade a mini and it shows up here.</li>';
}
