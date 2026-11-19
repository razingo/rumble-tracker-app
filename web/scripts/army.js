'use strict';
// Army tab: army builder (leader + 6 minis) with each mini's level in its slot.
// Depends on globals from app.js.

const DMG_TAG = { AOE: 'AoE', Squad: 'Squad', OneTarget: 'One-Target' };

/** Attributes a slot type can match: family, roles, traits, damage type, category. */
function miniTags(m) {
  const tags = new Set([...familiesOf(m), ...String(m.role).split(','), ...m.traits.map((t) => t.name)]);
  if (m.category === 'Spell') tags.add('Spell');
  if (DMG_TAG[m.damageType]) tags.add(DMG_TAG[m.damageType]);
  if (tags.has('Siege Damage') || tags.has('Siege Specialist')) tags.add('Siege');
  return tags;
}

function slotMatches(type, m) {
  if (!type || !m) return false;
  if (type === 'Wildcard') return true;
  return miniTags(m).has(type);
}

const ownedUnit = (slug) => state.units.find((u) => u.slug === slug) || null;

// ---- faction pennant -----------------------------------------------------------------------------
const FAMILY_NAMES = ['Alliance', 'Horde', 'Undead', 'Beast', 'Blackrock', 'Cenarion'];
// combined faction icons (static/icons/fam)
const FAMILY_COMBOS = ['AllianceHorde', 'AllianceUndead', 'BeastAlliance', 'BeastBlackrock', 'BlackrockAlliance', 'BlackrockUndead', 'HordeBeast', 'HordeBlackrock', 'UndeadBeast', 'UndeadHorde'];

/** A mini's families; for leaders, every faction among their fixed board slots. */
function familiesOf(m) {
  if (m.families?.length > 1) return m.families; // multi-faction minis
  if (m.category === 'Leader') {
    const fams = [...new Set((m.fixedArmySlots || []).filter((t) => FAMILY_NAMES.includes(t)))];
    if (fams.length > 1) return fams;
  }
  return [m.family];
}

function famFlag(m) {
  const fams = familiesOf(m);
  if (fams.length === 1) {
    return `<span class="fam-flag fam-${fams[0].toLowerCase()}" title="${esc(fams[0])}">${ico(TAG_ICONS[fams[0]], fams[0])}</span>`;
  }
  const combo = FAMILY_COMBOS.find((c) => c === fams[0] + fams[1] || c === fams[1] + fams[0]);
  const icon = combo ? `<img class="ico" src="/static/icons/fam/${combo}.png" alt="">` : ico(TAG_ICONS[fams[0]], fams[0]);
  return `<span class="fam-flag fam-split" style="--fam-a:var(--fam-${fams[0].toLowerCase()});--fam-b:var(--fam-${fams[1].toLowerCase()})" title="${esc(fams.join(' + '))}">${icon}</span>`;
}

/** Level of unit u in slot i of leader L's army. */
function levelInSlot(u, L, i) {
  const A = RULES.armySlots;
  const slot = armyOf(L)[i];
  const tier = A.tiers[slot.tier];
  if (!u || u.synthetic) return { level: null, match: false, bonus: 0, boosted: false, xpMax: false };
  const m = miniOf(u);
  const match = i === A.leaderSlot ? u.id === L.id : slotMatches(slot.type, m);
  const xp = slot.boost ? Math.max(u.xpLevel, RULES.maxXpLevel) : u.xpLevel;
  const bonus = match ? tier.bonus : 0;
  return {
    level: Math.min(RULES.maxLevel, xp + u.rarity + u.talents + bonus),
    match, bonus,
    boosted: slot.boost && u.xpLevel < RULES.maxXpLevel,
    xpMax: xp >= RULES.maxXpLevel,
  };
}

// ---- game army codes ("rumblo:" + base64 protobuf) --------------------------------------------
// { 1: leader index, 2: leader talent, 3: [{ 1: mini index, 2: talent }] x6 }
// Indices are the game's short IDs (static/army_code_minis.json).
let CODE_TABLE = null;
async function codeTable() {
  if (!CODE_TABLE) {
    const t = await fetch('/static/army_code_minis.json').then((r) => r.json());
    const toSlug = new Map(Object.entries(t.shortIds).map(([id, slug]) => [Number(id), slug]));
    const toId = new Map([...toSlug].map(([id, slug]) => [slug, id]));
    // codes use the game's talent order; talentOrder[slug][gameIndex] maps it to the tracker's order
    const order = t.talentOrder || {};
    const toApp = (slug, gameIdx) => order[slug]?.[gameIdx] ?? gameIdx;
    const toGame = (slug, appIdx) => { const k = order[slug]?.indexOf(appIdx) ?? -1; return k >= 0 ? k : appIdx; };
    CODE_TABLE = { prefix: t.prefix || 'rumblo:', toSlug, toId, toApp, toGame };
  }
  return CODE_TABLE;
}

function pbVarint(n, out) { do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); }

async function encodeArmyCode(d) {
  const table = await codeTable();
  const idx = (slug) => table.toId.get(slug) ?? -1;
  // chosen talent, else the first unlocked, else the first
  const talentOf = (slug) => {
    const chosen = d.talents?.[slug];
    const u = ownedUnit(slug);
    const appIdx = Number.isInteger(chosen) ? chosen : (u ? effectivePicks(u)[0] : null) ?? 0;
    return table.toGame(slug, appIdx);
  };
  if (idx(d.leader) < 0) throw new Error('Choose a leader first.');
  const out = [];
  out.push(0x08); pbVarint(idx(d.leader), out);
  out.push(0x10); pbVarint(talentOf(d.leader), out);
  for (const slug of d.minis) {
    if (!slug || idx(slug) < 0) continue;
    const inner = [0x08]; pbVarint(idx(slug), inner); inner.push(0x10); pbVarint(talentOf(slug), inner);
    out.push(0x1a); pbVarint(inner.length, out); out.push(...inner);
  }
  return `${table.prefix}${btoa(String.fromCharCode(...out))}`;
}

async function decodeArmyCode(code) {
  const table = await codeTable();
  const raw = atob(code.trim().replace(/^rumblo:/i, ''));
  const b = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const varint = (p) => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r, p]; };
  const fields = (s, e) => {
    const res = []; let p = s;
    while (p < e) {
      let t; [t, p] = varint(p);
      const fn = t >> 3, wt = t & 7;
      if (wt === 0) { let v; [v, p] = varint(p); res.push({ fn, v }); }
      else if (wt === 2) { let l; [l, p] = varint(p); res.push({ fn, sub: fields(p, p + l) }); p += l; }
      else throw new Error('Not a Warcraft Rumble army code.');
    }
    return res;
  };
  const top = fields(0, b.length);
  const slugAt = (i) => { const s = table.toSlug.get(i); if (!s) throw new Error(`Unknown mini number ${i} in code.`); return s; };
  const leader = slugAt(top.find((f) => f.fn === 1)?.v ?? -1);
  const talents = { [leader]: table.toApp(leader, top.find((f) => f.fn === 2)?.v ?? 0) };
  const minis = top.filter((f) => f.fn === 3).map((f) => {
    const slug = slugAt(f.sub.find((x) => x.fn === 1)?.v ?? 0);
    talents[slug] = table.toApp(slug, f.sub.find((x) => x.fn === 2)?.v ?? 0);
    return slug;
  });
  while (minis.length < 6) minis.push(null);
  return { leader, minis: minis.slice(0, 6), talents };
}

// ---- draft (the army being edited) ------------------------------------------------------------
const emptyDraft = () => ({ id: null, name: 'New army', leader: null, minis: [null, null, null, null, null, null], talents: {}, description: '', tags: [] });

/** Tags used in this account's armies, most frequent first. */
function allArmyTags() {
  const count = new Map();
  for (const a of [...(state.savedArmies || []), ui.armyDraft || {}]) {
    for (const t of a.tags || []) {
      const k = t.toLowerCase();
      const e = count.get(k) || { tag: t, n: 0 };
      e.n++;
      count.set(k, e);
    }
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((e) => e.tag);
}

function addTag(raw) {
  const d = ui.armyDraft;
  const v = String(raw).trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!v || (d.tags || []).some((t) => t.toLowerCase() === v.toLowerCase()) || (d.tags || []).length >= 20) return false;
  // keep the existing spelling of a known tag
  const known = allArmyTags().find((t) => t.toLowerCase() === v.toLowerCase());
  d.tags = [...(d.tags || []), known || v];
  saveDraftLocal();
  return true;
}
// The draft is stored by the server (data/drafts.json, per account); saves are debounced.
const legacyDraftKey = () => `armyDraft:${state?.account || ''}`;
function loadDraft() {
  let d = state.draft;
  if (!d) {
    // migrate a draft kept in browser storage by older versions
    const old = store.get(legacyDraftKey(), null);
    if (old && Array.isArray(old.minis)) { d = old; ui.armyDraft = { ...emptyDraft(), ...d }; saveDraftLocal(); }
    try { localStorage.removeItem(legacyDraftKey()); } catch { /* ignore */ }
  }
  ui.armyDraft = d && Array.isArray(d.minis) ? { ...emptyDraft(), ...d } : emptyDraft();
}

let draftTimer = null;
let draftPending = null;
function saveDraftLocal() {
  draftPending = { account: state.account, draft: JSON.parse(JSON.stringify(ui.armyDraft)) };
  state.draft = draftPending.draft; // keep the local copy current
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}
async function flushDraft() {
  clearTimeout(draftTimer);
  const job = draftPending;
  draftPending = null;
  if (!job) return;
  try { await post('/api/draft', job); } catch { draftPending = draftPending || job; draftTimer = setTimeout(flushDraft, 3000); }
}
// flush the last edit on page close or account change
window.addEventListener('pagehide', () => {
  if (!draftPending) return;
  navigator.sendBeacon?.('/api/draft', new Blob([JSON.stringify(draftPending)], { type: 'application/json' }));
});

/** Unit in slot i of the draft (0: leader). */
function draftUnit(i) {
  const d = ui.armyDraft;
  return ownedUnit(i === 0 ? d.leader : d.minis[i - 1]);
}

/** Talent used in this army: chosen, else first unlocked, else first. */
function equippedTalent(u) {
  const m = miniOf(u);
  if (!m?.talents.length) return null;
  const chosen = ui.armyDraft.talents[u.slug];
  if (Number.isInteger(chosen) && chosen >= 0 && chosen < m.talents.length) return chosen;
  return effectivePicks(u)[0] ?? 0;
}

// ---- rendering ---------------------------------------------------------------------------------
function renderArmy() {
  if (!state) return;
  if (!ui.armyDraft || ui.armyDraftAccount !== state.account) {
    if (draftPending && draftPending.account !== state.account) flushDraft(); // save the previous account's draft
    loadDraft();
    ui.armyDraftAccount = state.account;
  }
  const d = ui.armyDraft;
  const L = draftUnit(0);
  const saved = state.savedArmies || [];

  const toolbar = `<div class="army-toolbar panel">
    <label>Saved armies
      <select id="armySaved"><option value="">— unsaved —</option>${saved.map((a) => `<option value="${esc(a.id)}" ${a.id === d.id ? 'selected' : ''}>${esc(a.name)}${a.tags?.length ? ` · ${esc(a.tags.join(', '))}` : ''}</option>`).join('')}</select>
    </label>
    <input id="armyName" class="keep" maxlength="40" value="${esc(ui.armyNameText || '')}" aria-label="Army name"
      placeholder="${d.id ? `Rename “${esc(d.name)}”` : 'Name this army'}">
    <button class="btn" data-army-act="save">${d.id ? 'Save' : 'Save as new'}</button>
    ${d.id ? '<button class="chip" data-army-act="saveas">Save as copy</button>' : ''}
    <button class="chip" data-army-act="new">New</button>
    ${d.id ? '<button class="chip danger" data-army-act="delete">Delete</button>' : ''}
    <div class="army-meta">
      <textarea id="armyDesc" class="keep" rows="2" maxlength="1000" placeholder="Description (optional): when to use it, what it counters…" aria-label="Army description">${esc(d.description || '')}</textarea>
      <div class="tag-editor" aria-label="Tags">
        ${(d.tags || []).map((t) => `<span class="tag-chip">${esc(t)}<button data-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}
        <input id="armyTagInput" class="keep" list="armyTagList" placeholder="${(d.tags || []).length ? 'Add tag…' : 'Tags (optional): type and press Enter'}" maxlength="30">
        <datalist id="armyTagList">${allArmyTags().filter((t) => !(d.tags || []).some((x) => x.toLowerCase() === t.toLowerCase())).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      </div>
    </div>
    <span class="code-box">
      <input id="armyCode" class="keep mono" placeholder="rumblo:… army code" aria-label="Army code" value="${esc(ui.armyCodeText || '')}">
      <button class="chip" data-army-act="import">Import code</button>
      <button class="chip" data-army-act="export">Copy code</button>
    </span>
    ${ui.armyCodeMsg ? `<span class="small ${ui.armyCodeMsg.ok ? 'cost-ok' : 'cost-no'}">${esc(ui.armyCodeMsg.text)}</span>` : ''}
  </div>`;

  const cells = [];
  const stats = [];
  for (let i = 0; i < RULES.armySlots.count; i++) {
    // without a leader, show untyped empty slots
    const slot = L ? armyOf(L)[i] : { type: i === 0 ? 'Leader' : '', tier: 0, boost: false };
    const tier = RULES.armySlots.tiers[slot.tier];
    const u = draftUnit(i);
    const m = u ? miniOf(u) : null;
    const lv = L ? levelInSlot(u, L, i) : { level: u && !u.synthetic ? u.level : null, match: false, bonus: 0 };
    if (m) stats.push({ cost: m.cost, level: lv.level });
    const t = u ? equippedTalent(u) : null;
    const talent = m && t != null ? m.talents[t] : null;
    const typeLabel = i === 0 ? 'Leader' : slot.type || (L ? 'Type not set' : '—');
    const typeIcon = TAG_ICONS[typeLabel];
    const noSynergy = u && i > 0 && L && !lv.match; // mini doesn't match the slot type
    cells.push(`<div class="aslot tier-${slot.tier}${i === 0 ? ' aslot-leader' : ''}${u ? '' : ' empty'}${lv.match ? ' matched' : ''}${noSynergy ? ' no-synergy' : ''}" data-drop-slot="${i}" style="--tc:${tier.color};--rc:${u ? rarityColor(u.rarity) : 'var(--line)'}">
      <div class="aslot-head${typeIcon ? ' has-icon' : ''}" title="${esc(typeLabel)} · ${tier.name}${tier.bonus ? ` +${tier.bonus}` : ''}${slot.boost ? ' · Boost' : ''}">
        ${typeIcon ? `<span class="medal">${ico(typeIcon, typeLabel)}</span>` : ''}<span class="aslot-label">${esc(typeLabel)}</span>${slot.boost ? '<span class="boost-mark">⚡</span>' : ''}
      </div>
      <button class="aslot-body" data-aslot="${i}" ${u && i > 0 ? `draggable="true" data-drag-slot="${i}"` : ''} aria-label="${u ? `Remove ${esc(m.name)}` : 'Empty slot'}" title="${u ? 'Click to remove · right-click for details' : ''}">
        ${m ? famFlag(m) : ''}
        ${m ? `<img class="portrait" src="/static/${m.art}" alt="" draggable="false">` : '<span class="add">+</span>'}
        ${m ? `<span class="cost">${m.cost}</span>` : ''}
        ${lv.match && lv.bonus ? `<span class="up" title="Slot bonus +${lv.bonus}">▲${lv.bonus}</span>` : ''}
        ${m ? `<span class="aname">${esc(m.name)}</span>` : `<span class="aname muted">${i === 0 ? 'Drop or pick a leader' : L ? 'Drop or pick a mini' : 'Pick a leader first'}</span>`}
      </button>
      <div class="aslot-foot">
        ${u && lv.level != null ? `<b>${lv.level}</b>${lv.xpMax ? '<span class="max">MAX</span>' : ''}${lv.boosted ? '<span class="max boost">BOOST</span>' : ''}` : u ? '<span class="muted">—</span>' : ''}
        ${talent ? `<button class="atalent${effectivePicks(u).includes(t) ? '' : ' locked'}" data-atalent="${i}" title="Talent: ${esc(talent.name)} (click to choose)">${ico(talent.icon, talent.name).replace('class="ico"', 'class="ico talent-ico"')}</button>` : ''}
      </div>
      ${ui.talentPop === i && u && talent ? talentPopup(i, u) : ''}
    </div>`);
  }

  const lvls = stats.map((s) => s.level).filter((x) => x != null);
  const avgLevel = lvls.length ? (lvls.reduce((a, b) => a + b, 0) / lvls.length).toFixed(1) : '–';
  const avgCost = stats.length ? (stats.reduce((a, s) => a + s.cost, 0) / stats.length).toFixed(1) : '–';

  // notes: unmatched minis, missing slot setup
  const notes = [];
  if (L && !L.army) notes.push(`${esc(miniOf(L).name)}'s army slots aren't set yet. Set types and tiers in the leader's panel.`);
  for (let i = 1; i < RULES.armySlots.count && L; i++) {
    const u = draftUnit(i);
    if (!u || u.synthetic) continue;
    const lv = levelInSlot(u, L, i);
    const slot = armyOf(L)[i];
    if (!lv.match && slot.tier > 0) notes.push(`${esc(miniOf(u).name)} isn't a ${esc(slot.type || 'matching')} mini, so it doesn't get this slot's +${RULES.armySlots.tiers[slot.tier].bonus} bonus.`);
  }
  const missing = d.minis.filter((s) => s && !ownedUnit(s));
  if (missing.length) notes.push(`Not owned on this account: ${missing.map((s) => esc(BY_SLUG.get(s)?.name || s)).join(', ')}.`);

  $('#tab-army').innerHTML = `${toolbar}
    <div class="army-wrap panel board-${L ? String(familiesOf(miniOf(L))[0]).toLowerCase() : 'neutral'}">
      <div class="army-head">
        <div class="army-stat" title="Average level"><span class="hex">⬢</span>${avgLevel}</div>
        <h2 class="army-title">${L ? `${esc(miniOf(L).name)}'s Army` : 'New army'}</h2>
        <div class="army-head-right">
          <div class="army-stat" title="Average gold cost"><span class="gold">●</span>${avgCost}</div>
          <button class="chip danger" data-army-act="clear" title="Remove the leader and all minis">Clear army</button>
        </div>
      </div>
      <div class="army-board">${cells.join('')}</div>
      ${notes.length ? `<ul class="army-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
      <div class="small muted">Drag or click cards to add them; drag between slots to swap, or back down to remove. Level in slot = XP level + rarity + talents + the tier bonus if the mini matches the slot (Wildcard matches all); a Boost slot counts as XP level 20.</div>
    </div>
    <div class="army-pools" data-drop-remove>
      <section class="panel pool" id="pool-leaders"></section>
      <section class="panel pool" id="pool-units"></section>
    </div>`;
  renderPool('leaders');
  renderPool('units');
}

// ---- pools: Leaders and Units & Spells ---------------------------------------------------------
const POOL_DEFAULT = { leaders: { q: '', fam: [], traits: [], traitMode: 'all', sort: 'level' }, units: { q: '', fam: [], type: [], traits: [], traitMode: 'all', sort: 'level' } };
function pools() {
  if (!ui.pools) {
    const s = store.get('armyPools', {});
    ui.pools = { leaders: { ...POOL_DEFAULT.leaders, ...s.leaders, q: '' }, units: { ...POOL_DEFAULT.units, ...s.units, q: '' } };
  }
  return ui.pools;
}
const savePools = () => store.set('armyPools', ui.pools);

/** Slots (1-6) of the current leader that this mini matches; Wildcard slots only if requested. */
function matchingSlots(m, includeWildcard = false) {
  const L = draftUnit(0);
  if (!L || !m) return [];
  return armyOf(L).map((s, i) => (i > 0 && (includeWildcard || s.type !== 'Wildcard') && slotMatches(s.type, m) ? i : null)).filter((x) => x != null);
}

function poolItems(kind) {
  const p = pools()[kind];
  const d = ui.armyDraft;
  const used = new Set([d.leader, ...d.minis].filter(Boolean));
  const q = p.q.trim().toLowerCase();
  const items = state.units
    .map((u) => ({ u, m: miniOf(u) }))
    .filter(({ u, m }) => m && !u.synthetic && (kind === 'leaders' ? m.category === 'Leader' : m.category !== 'Leader'))
    .filter(({ m }) => !q || m.name.toLowerCase().includes(q))
    .filter(({ m }) => !p.fam.length || familiesOf(m).some((f) => p.fam.includes(f)))
    .filter(({ m }) => kind === 'leaders' || !p.type.length || p.type.includes(m.category))
    .filter(({ m }) => !p.traits.length || p.traits[p.traitMode === 'any' ? 'some' : 'every']((t) => m.traits.some((x) => x.name === t)))
    .map((x) => ({ ...x, used: used.has(x.u.slug), level: kind === 'leaders' ? totalLevel(x.u) : x.u.level, slots: kind === 'units' ? matchingSlots(x.m) : [] }));
  const by = {
    level: (a, b) => b.level - a.level || a.m.name.localeCompare(b.m.name),
    name: (a, b) => a.m.name.localeCompare(b.m.name),
    cost: (a, b) => a.m.cost - b.m.cost || a.m.name.localeCompare(b.m.name),
    match: (a, b) => b.slots.length - a.slots.length || b.level - a.level,
  }[p.sort] || ((a, b) => b.level - a.level);
  return items.sort(by);
}

function poolCard(x, kind) {
  const { u, m } = x;
  const L = draftUnit(0);
  const tip = kind === 'units' && L ? (x.slots.length ? `Matches slot ${x.slots.join(', ')}` : 'No matching slot') : '';
  return `<button class="pcard${x.used ? ' used' : ''}${x.slots.length ? ' fits' : ''}" draggable="true" data-pool-slug="${u.slug}" data-pool-kind="${kind}" style="--rc:${rarityColor(u.rarity)}" title="${esc(m.name)}${tip ? ` · ${tip}` : ''}${x.used ? ' · in this army' : ''}">
    <img src="/static/${m.art}" alt="" draggable="false">
    <span class="pcost">${m.cost}</span>
    <span class="pname">${esc(m.name)}</span>
    <span class="plvl">${x.level}</span>
  </button>`;
}

function renderPool(kind) {
  const el = $(`#pool-${kind}`);
  if (!el) return;
  const p = pools()[kind];
  const famChips = FAMILIES.map((f) => `<button class="chip small-chip" aria-pressed="${p.fam.includes(f)}" data-pool-fam="${f}" data-pool="${kind}" title="${f}">${ico(TAG_ICONS[f], f)}</button>`);
  const typeChips = kind === 'units' ? [['Unit', 'Units'], ['Spell', 'Spells']].map(([k, l]) => `<button class="chip small-chip" aria-pressed="${p.type.includes(k)}" data-pool-type="${k}" data-pool="${kind}">${l}</button>`).join('') : '';
  const sorts = [['level', 'Level'], ['name', 'Name'], ['cost', 'Cost'], ...(kind === 'units' ? [['match', 'Fits slots']] : [])];
  // traits present in this pool
  const inPane = new Set(state.units.map(miniOf).filter((m) => m && (kind === 'leaders' ? m.category === 'Leader' : m.category !== 'Leader')).flatMap((m) => m.traits.map((t) => t.name)));
  const traits = allTraits().filter((t) => inPane.has(t.name));
  const open = ui.poolTraitOpen === kind;
  // floating trait picker: match mode on top, selected traits first, then A-Z
  const tq = (ui.poolTraitQ ||= {})[kind] || '';
  const opt = (t) => `<label class="trait-opt" data-trait-name="${esc(t.name.toLowerCase())}"${tq && !t.name.toLowerCase().includes(tq) ? ' hidden' : ''}>
        <input type="checkbox" data-pool-trait-box="${esc(t.name)}" data-pool="${kind}" ${p.traits.includes(t.name) ? 'checked' : ''}>
        ${ico(t.icon, t.name)}<span>${esc(t.name)}</span></label>`;
  const ticked = traits.filter((t) => p.traits.includes(t.name));
  const rest = traits.filter((t) => !p.traits.includes(t.name));
  const any = p.traitMode === 'any';
  const popup = open ? `<div class="trait-pop pool-traits" role="dialog" aria-label="Traits">
      <div class="trait-pop-head">
        <span class="seg"><button class="chip small-chip" aria-pressed="${!any}" data-pool-mode="all" data-pool="${kind}" title="Minis with every selected trait">Match all</button><button class="chip small-chip" aria-pressed="${any}" data-pool-mode="any" data-pool="${kind}" title="Minis with any selected trait">Match any</button></span>
        ${p.traits.length ? `<button class="chip small-chip" data-pool-clear-traits="${kind}">Clear</button>` : ''}
      </div>
      <input class="trait-search keep" type="search" data-pool-trait-search="${kind}" placeholder="Search traits…" value="${esc(tq)}">
      <div class="trait-list">${ticked.map(opt).join('')}${ticked.length && rest.length ? '<hr class="trait-sep">' : ''}${rest.map(opt).join('')}</div>
    </div>` : '';
  el.innerHTML = `<div class="pool-head">
      <h2>${kind === 'leaders' ? 'Leaders' : 'Units & Spells'}</h2>
      <input class="pool-search keep" type="search" data-pool-search="${kind}" placeholder="Search…" value="${esc(p.q)}">
    </div>
    ${(() => {
      const traitsBtn = `<span class="trait-anchor"><button class="chip small-chip" aria-expanded="${open}" aria-pressed="${p.traits.length > 0}" data-pool-traits="${kind}">Traits${p.traits.length ? ` (${p.traits.length})` : ''} ▾</button>${popup}</span>`;
      const sortSel = `<select data-pool-sort="${kind}" aria-label="Sort">${sorts.map(([k, l]) => `<option value="${k}" ${p.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const active = !!(p.q || p.fam.length || p.type?.length || p.traits.length);
      const clearBtn = `<button class="chip small-chip clear-filters" data-pool-clear="${kind}" ${active ? '' : 'disabled'}>✕ Clear filters</button>`;
      if (kind !== 'leaders') return `<div class="pool-filters">${typeChips}${famChips.join('')}${traitsBtn}${clearBtn}${sortSel}</div>`;
      // Leaders pool: two rows of three factions
      return `<div class="pool-filters pool-filters-rows">
        <div class="pf-row">${famChips.slice(0, 3).join('')}${traitsBtn}</div>
        <div class="pf-row">${famChips.slice(3).join('')}${clearBtn}${sortSel}</div>
      </div>`;
    })()}
    <div class="pool-well"><div class="pool-grid" id="pool-grid-${kind}"></div></div>`;
  renderPoolGrid(kind);
}

function renderPoolGrid(kind) {
  const grid = $(`#pool-grid-${kind}`);
  if (!grid) return;
  const items = poolItems(kind);
  grid.innerHTML = items.map((x) => poolCard(x, kind)).join('') || '<p class="muted small">Nothing matches.</p>';
  if (!grid.dataset.fadeBound) {
    grid.dataset.fadeBound = '1';
    grid.addEventListener('scroll', () => poolFade(grid), { passive: true });
    // also on first display and on resize
    if (window.ResizeObserver) new ResizeObserver(() => poolFade(grid)).observe(grid);
  }
  poolFade(grid);
}

/** Marks which pool edges have more content beyond them (faded in CSS). */
function poolFade(grid) {
  const up = grid.scrollTop > 2;
  const down = grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2;
  const more = up && down ? 'both' : up ? 'top' : down ? 'bottom' : '';
  if (grid.dataset.more !== more) grid.dataset.more = more;
}

// ---- placing minis -----------------------------------------------------------------------------------
function placeLeader(slug) {
  ui.armyDraft.leader = slug;
  saveDraftLocal();
  renderArmy();
}

/** Places a mini in slot i (1-6); swaps if it is already on the board. */
function placeMini(slug, i) {
  const d = ui.armyDraft;
  const prev = d.minis[i - 1];
  const at = d.minis.indexOf(slug);
  if (at >= 0) d.minis[at] = prev;
  d.minis[i - 1] = slug;
  saveDraftLocal();
  renderArmy();
}

/** Adds a pool card: a leader replaces the leader; a mini takes the best empty slot. */
function addFromPool(slug, kind) {
  const d = ui.armyDraft;
  if (kind === 'leaders') return placeLeader(slug);
  if (d.minis.includes(slug)) { d.minis[d.minis.indexOf(slug)] = null; saveDraftLocal(); return renderArmy(); }
  const empty = d.minis.map((s, k) => (s ? null : k + 1)).filter((x) => x != null);
  if (!empty.length) { ui.armyCodeMsg = { ok: false, text: 'The army is full - drag a mini onto a slot to replace it.' }; return renderArmy(); }
  // matching slot first, then Wildcard, then any empty slot
  const m = miniOf(ownedUnit(slug));
  const fits = matchingSlots(m).filter((i) => empty.includes(i));
  const wild = matchingSlots(m, true).filter((i) => empty.includes(i));
  placeMini(slug, fits[0] ?? wild[0] ?? empty[0]);
}

function swapSlots(a, b) {
  const d = ui.armyDraft;
  [d.minis[a - 1], d.minis[b - 1]] = [d.minis[b - 1], d.minis[a - 1]];
  saveDraftLocal();
  renderArmy();
}

function removeSlot(i) {
  ui.armyDraft.minis[i - 1] = null;
  saveDraftLocal();
  renderArmy();
}

// ---- talent popup ------------------------------------------------------------------------------
function talentPopup(i, u) {
  const m = miniOf(u);
  const owned = new Set(effectivePicks(u));
  const current = equippedTalent(u);
  return `<div class="talent-pop" role="dialog" aria-label="Choose a talent for ${esc(m.name)}">
    <div class="talent-pop-title">${esc(m.name)}: talent</div>
    ${m.talents.map((t, k) => `<button class="talent-opt${k === current ? ' on' : ''}${owned.has(k) ? '' : ' locked'}" data-pick-talent="${k}">
      <img src="/static/${t.icon}" alt="">
      <span><b>${esc(t.name)}</b>${owned.has(k) ? '' : ' <small class="muted">(not unlocked)</small>'}<span class="small desc">${esc(t.description)}</span></span>
    </button>`).join('')}
  </div>`;
}

// ---- saving ----------------------------------------------------------------------------------------
async function persistArmies(list) {
  await post('/api/armies', { account: state.account, armies: list });
  await poll();
}

async function armyAction(act) {
  const d = ui.armyDraft;
  const list = [...(state.savedArmies || [])];
  if (act === 'new') { ui.armyDraft = emptyDraft(); ui.armyNameText = ''; saveDraftLocal(); renderArmy(); return; }
  if (act === 'clear') {
    // empties the board, keeping the name and saved army
    ui.armyDraft = { ...d, leader: null, minis: [null, null, null, null, null, null], talents: {} };
    ui.talentPop = null;
    saveDraftLocal(); renderArmy(); return;
  }
  if (act === 'import') {
    const text = ($('#armyCode')?.value || '').trim();
    ui.armyCodeText = text;
    try {
      const a = await decodeArmyCode(text);
      ui.armyDraft = { ...emptyDraft(), name: 'Imported army', ...a };
      ui.armyCodeMsg = { ok: true, text: 'Army imported.' };
      ui.armyCodeText = ''; // a failed import keeps the text for correction
      saveDraftLocal();
    } catch (err) { ui.armyCodeMsg = { ok: false, text: err.message || 'Could not read that code.' }; }
    renderArmy(); return;
  }
  if (act === 'export') {
    try {
      const code = await encodeArmyCode(d);
      ui.armyCodeText = code;
      let copied = false;
      try { await navigator.clipboard.writeText(code); copied = true; } catch { /* clipboard blocked */ }
      ui.armyCodeMsg = { ok: true, text: copied ? 'Code copied to clipboard.' : 'Code ready - copy it from the box.' };
    } catch (err) { ui.armyCodeMsg = { ok: false, text: err.message }; }
    renderArmy(); return;
  }
  if (act === 'delete' && d.id) {
    if (!confirm(`Delete "${d.name}"?`)) return;
    await persistArmies(list.filter((a) => a.id !== d.id));
    ui.armyDraft = { ...d, id: null };
    saveDraftLocal(); renderArmy(); return;
  }
  if (act === 'save' || act === 'saveas') {
    const id = act === 'save' && d.id ? d.id : `a${Date.now().toString(36)}`;
    // typed name, else the saved name, else a generated one
    const typed = ($('#armyName')?.value || '').trim();
    const leaderName = d.leader ? BY_SLUG.get(d.leader)?.name : null;
    const fallback = act === 'save' && d.id ? d.name : `${leaderName ? `${leaderName} army` : 'Army'} ${list.length + 1}`;
    const name = typed || fallback;
    const pendingTag = ($('#armyTagInput')?.value || '').trim();
    if (pendingTag) addTag(pendingTag); // keep an unconfirmed tag
    const entry = { id, name, leader: d.leader, minis: d.minis, talents: d.talents, description: d.description || '', tags: d.tags || [] };
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    await persistArmies(list);
    ui.armyDraft = { ...d, id, name };
    ui.armyNameText = '';
    ui.armyCodeMsg = { ok: true, text: `Saved “${name}”.` };
    saveDraftLocal(); renderArmy();
  }
}

function bindArmy() {
  const page = $('#tab-army');

  // pool search re-renders only the grid, keeping focus
  // tags: Enter or comma adds; Backspace in an empty box removes the last
  page.addEventListener('keydown', (e) => {
    if (e.target.id !== 'armyTagInput') return;
    const input = e.target;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (addTag(input.value)) { renderArmy(); $('#armyTagInput')?.focus(); } else input.value = '';
    } else if (e.key === 'Backspace' && !input.value && ui.armyDraft.tags?.length) {
      ui.armyDraft.tags = ui.armyDraft.tags.slice(0, -1);
      saveDraftLocal(); renderArmy(); $('#armyTagInput')?.focus();
    }
  });

  page.addEventListener('input', (e) => {
    if (e.target.id === 'armyDesc') {
      ui.armyDraft.description = e.target.value;
      saveDraftLocal(); // no re-render while typing
      return;
    }
    const traitPane = e.target.dataset?.poolTraitSearch;
    if (traitPane) {
      const q = e.target.value.trim().toLowerCase();
      (ui.poolTraitQ ||= {})[traitPane] = q;
      for (const o of $(`#pool-${traitPane}`).querySelectorAll('.trait-opt')) o.hidden = !!q && !o.dataset.traitName.includes(q);
      return;
    }
    const kind = e.target.dataset?.poolSearch;
    if (!kind) return;
    const p = pools()[kind];
    p.q = e.target.value;
    renderPoolGrid(kind);
    // only the tiles re-render while typing, so update Clear filters here
    const clear = $(`#pool-${kind} [data-pool-clear]`);
    if (clear) clear.disabled = !(p.q || p.fam.length || p.type?.length || p.traits.length);
  });

  // right-click opens the mini's details
  page.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const slot = e.target.closest('[data-aslot]');
    const u = card ? ownedUnit(card.dataset.poolSlug) : slot ? draftUnit(Number(slot.dataset.aslot)) : null;
    if (!u) return;
    e.preventDefault();
    openDrawer({ kind: 'unit', id: u.id });
  });

  // ---- drag and drop ----
  let drag = null; // { slug, kind: 'leaders'|'units' } or { fromSlot }
  const canDrop = (i) => {
    if (!drag) return false;
    if (drag.fromSlot != null) return i > 0 && i !== drag.fromSlot;
    if (drag.kind === 'leaders') return i === 0;
    return i > 0 && !!draftUnit(0);
  };
  page.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const fromBoard = e.target.closest('[data-drag-slot]');
    if (card) drag = { slug: card.dataset.poolSlug, kind: card.dataset.poolKind };
    else if (fromBoard) drag = { fromSlot: Number(fromBoard.dataset.dragSlot) };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.slug || `slot:${drag.fromSlot}`);
    page.classList.add('dragging');
    for (const s of page.querySelectorAll('[data-drop-slot]')) s.classList.toggle('drop-ok', canDrop(Number(s.dataset.dropSlot)));
  });
  page.addEventListener('dragend', () => {
    drag = null;
    page.classList.remove('dragging');
    for (const s of page.querySelectorAll('.drop-ok,.drop-hover')) s.classList.remove('drop-ok', 'drop-hover');
  });
  page.addEventListener('dragover', (e) => {
    const slot = e.target.closest('[data-drop-slot]');
    const remove = !slot && drag?.fromSlot != null && e.target.closest('[data-drop-remove]');
    if ((slot && canDrop(Number(slot.dataset.dropSlot))) || remove) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      for (const s of page.querySelectorAll('.drop-hover')) if (s !== slot) s.classList.remove('drop-hover');
      slot?.classList.add('drop-hover');
    }
  });
  page.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const slot = e.target.closest('[data-drop-slot]');
    const d = drag;
    drag = null;
    if (slot) {
      const i = Number(slot.dataset.dropSlot);
      if (d.fromSlot != null) swapSlots(d.fromSlot, i);
      else if (d.kind === 'leaders') placeLeader(d.slug);
      else placeMini(d.slug, i);
    } else if (d.fromSlot != null) removeSlot(d.fromSlot);
  });

  page.addEventListener('click', (e) => {
    // close popups on outside clicks
    if (ui.talentPop != null && !e.target.closest('.talent-pop,[data-atalent]')) { ui.talentPop = null; renderArmy(); }
    if (ui.poolTraitOpen && !e.target.closest('.pool-traits,[data-pool-traits]')) { const k = ui.poolTraitOpen; ui.poolTraitOpen = null; renderPool(k); }
    const t = e.target.closest('[data-aslot],[data-atalent],[data-pick-talent],[data-army-act],[data-pool-slug],[data-pool-fam],[data-pool-type],[data-pool-traits],[data-pool-trait],[data-pool-mode],[data-pool-clear-traits],[data-pool-clear],[data-tag-remove]');
    if (!t) return;
    if (t.dataset.tagRemove != null) {
      ui.armyDraft.tags = (ui.armyDraft.tags || []).filter((x) => x !== t.dataset.tagRemove);
      saveDraftLocal(); return renderArmy();
    }
    if (t.dataset.poolSlug) return addFromPool(t.dataset.poolSlug, t.dataset.poolKind);
    if (t.dataset.poolFam || t.dataset.poolType) {
      const p = pools()[t.dataset.pool];
      if (t.dataset.poolFam) toggleIn(p.fam, t.dataset.poolFam); else toggleIn(p.type, t.dataset.poolType);
      savePools();
      return renderPool(t.dataset.pool);
    }
    if (t.dataset.poolMode) {
      pools()[t.dataset.pool].traitMode = t.dataset.poolMode;
      savePools();
      return renderPool(t.dataset.pool);
    }
    if (t.dataset.poolClear) {
      // reset search, factions, types and traits; sort and match mode are kept
      Object.assign(pools()[t.dataset.poolClear], { q: '', fam: [], traits: [], ...(t.dataset.poolClear === 'units' ? { type: [] } : {}) });
      savePools();
      return renderPool(t.dataset.poolClear);
    }
    if (t.dataset.poolClearTraits) {
      pools()[t.dataset.poolClearTraits].traits = [];
      savePools();
      return renderPool(t.dataset.poolClearTraits);
    }
    if (t.dataset.poolTraits) {
      ui.poolTraitOpen = ui.poolTraitOpen === t.dataset.poolTraits ? null : t.dataset.poolTraits;
      (ui.poolTraitQ ||= {})[t.dataset.poolTraits] = '';
      renderPool('leaders'); renderPool('units');
      $(`#pool-${t.dataset.poolTraits} .trait-search`)?.focus();
      return;
    }
    if (t.dataset.poolTrait) {
      toggleIn(pools()[t.dataset.pool].traits, t.dataset.poolTrait);
      savePools();
      return renderPool(t.dataset.pool);
    }
    if (t.dataset.pickTalent != null) {
      const u = draftUnit(ui.talentPop);
      ui.armyDraft.talents[u.slug] = Number(t.dataset.pickTalent);
      ui.talentPop = null;
      saveDraftLocal(); return renderArmy();
    }
    if (t.dataset.atalent != null) {
      const i = Number(t.dataset.atalent);
      ui.talentPop = ui.talentPop === i ? null : i;
      return renderArmy();
    }
    if (t.dataset.aslot != null) {
      // clicking a board slot removes its mini
      const i = Number(t.dataset.aslot);
      if (!draftUnit(i)) return;
      if (i === 0) { ui.armyDraft.leader = null; saveDraftLocal(); return renderArmy(); }
      return removeSlot(i);
    }
    if (t.dataset.armyAct) armyAction(t.dataset.armyAct).catch((err) => alert(err.message));
  });
  page.addEventListener('change', (e) => {
    if (e.target.dataset?.poolTraitBox) {
      const kind = e.target.dataset.pool;
      toggleIn(pools()[kind].traits, e.target.dataset.poolTraitBox);
      savePools();
      const list = $(`#pool-${kind} .trait-list`); const scroll = list?.scrollTop;
      renderPool(kind);
      const l2 = $(`#pool-${kind} .trait-list`); if (l2) l2.scrollTop = scroll || 0;
      return;
    }
    if (e.target.dataset?.poolSort) {
      pools()[e.target.dataset.poolSort].sort = e.target.value;
      savePools();
      renderPoolGrid(e.target.dataset.poolSort);
      return;
    }
    if (e.target.id === 'armySaved') {
      const a = (state.savedArmies || []).find((x) => x.id === e.target.value);
      ui.armyDraft = a ? { ...emptyDraft(), ...JSON.parse(JSON.stringify(a)) } : { ...ui.armyDraft, id: null };
      ui.armyNameText = '';
      saveDraftLocal(); renderArmy();
    } else if (e.target.id === 'armyName') {
      ui.armyNameText = e.target.value; // cleared on save
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.talentPop != null) { ui.talentPop = null; renderArmy(); }
    else if (ui.poolTraitOpen) { const k = ui.poolTraitOpen; ui.poolTraitOpen = null; renderPool(k); }
  });
}
