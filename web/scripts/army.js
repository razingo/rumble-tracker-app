// Army tab: the army builder, a leader and six minis, with the level each mini plays at in its slot.
import { poll } from './app.js';
import { FAMILIES, allTraits, toggleIn } from './collection.js';
import { $, store, getJson, post, copyText, RULES, BY_SLUG, TAG_ICONS, state, onTablesReload } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { ico, openDrawer } from './drawer.js';
import { SECOND } from './lib/constants.js';
import { esc } from './lib/format.js';
import { LIMITS, withTag } from './lib/limits.js';
import { traitPicker, bindTraitPicker } from './trait-picker.js';
import { rarityColor, miniOf, effectivePicks, armyOf, totalLevel } from './units.js';

// The army builder: the draft being edited and the state of its pickers and pop-ups.
const builder = { draft: null, draftAccount: null, nameText: '', codeMsg: null, codeText: '', talentPop: null,
  poolTraitOpen: null, poolTraitQ: {}, pools: null };

const DMG_TAG = { AOE: 'AoE', Squad: 'Squad', OneTarget: 'One-Target' };

/** What a slot type can match: the mini's families, roles, traits, damage type and category. */
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

// Faction pennant
const FAMILY_NAMES = ['Alliance', 'Horde', 'Undead', 'Beast', 'Blackrock', 'Cenarion'];
// Faction pairs with a combined icon (static/icons/fam).
const FAMILY_COMBOS = ['AllianceHorde', 'AllianceUndead', 'BeastAlliance', 'BeastBlackrock', 'BlackrockAlliance',
  'BlackrockUndead', 'HordeBeast', 'HordeBlackrock', 'UndeadBeast', 'UndeadHorde'];

/** A mini's families. For a leader, every faction among its fixed board slots. */
export function familiesOf(m) {
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
  return `<span class="fam-flag fam-split" style="--fam-a:var(--fam-${fams[0].toLowerCase()});--fam-b:var(--fam-${fams[1].toLowerCase()})"
    title="${esc(fams.join(' + '))}">${icon}</span>`;
}

/** The level unit u plays at in slot i of leader L's army. */
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

// Game army codes
// A code is "rumblo:" and base64 protobuf { 1: leader index, 2: leader talent, 3: [{ 1: mini index, 2: talent }] x6 },
// with the game's short IDs as indices (static/army_code_minis.json).
let CODE_TABLE = null;
onTablesReload(() => { CODE_TABLE = null; });
async function codeTable() {
  if (!CODE_TABLE) {
    const t = await getJson('/static/army_code_minis.json', 'the army code table');
    const toSlug = new Map(Object.entries(t.shortIds).map(([id, slug]) => [Number(id), slug]));
    const toId = new Map([...toSlug].map(([id, slug]) => [slug, id]));
    // Codes list talents in the game's order; talentOrder[slug][gameIndex] gives the tracker's index.
    const order = t.talentOrder || {};
    const toApp = (slug, gameIdx) => order[slug]?.[gameIdx] ?? gameIdx;
    const toGame = (slug, appIdx) => {
      const k = order[slug]?.indexOf(appIdx) ?? -1;
      return k >= 0 ? k : appIdx;
    };
    CODE_TABLE = { prefix: t.prefix || 'rumblo:', toSlug, toId, toApp, toGame };
  }
  return CODE_TABLE;
}

function pbVarint(n, out) {
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
}

export async function encodeArmyCode(d) {
  const table = await codeTable();
  const idx = (slug) => table.toId.get(slug) ?? -1;
  const talentOf = (slug) => table.toGame(slug, talentIndex(d, BY_SLUG.get(slug), ownedUnit(slug)) ?? 0);
  if (idx(d.leader) < 0) throw new Error('Choose a leader first.');
  const out = [];
  out.push(0x08);
  pbVarint(idx(d.leader), out);
  out.push(0x10);
  pbVarint(talentOf(d.leader), out);
  for (const slug of d.minis) {
    if (!slug || idx(slug) < 0) continue;
    const inner = [0x08];
    pbVarint(idx(slug), inner);
    inner.push(0x10);
    pbVarint(talentOf(slug), inner);
    out.push(0x1a);
    pbVarint(inner.length, out);
    out.push(...inner);
  }
  return `${table.prefix}${btoa(String.fromCharCode(...out))}`;
}

async function decodeArmyCode(code) {
  const table = await codeTable();
  const raw = atob(code.trim().replace(/^rumblo:/i, ''));
  const b = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const varint = (p) => {
    let r = 0, s = 0, x;
    do {
      x = b[p++];
      r |= (x & 0x7f) << s;
      s += 7;
    } while (x & 0x80);
    return [r, p];
  };
  const fields = (s, e) => {
    const res = [];
    let p = s;
    while (p < e) {
      let t;
      [t, p] = varint(p);
      const fn = t >> 3, wt = t & 7;
      if (wt === 0) {
        let v;
        [v, p] = varint(p);
        res.push({ fn, v });
      }
      else if (wt === 2) {
        let l;
        [l, p] = varint(p);
        res.push({ fn, sub: fields(p, p + l) });
        p += l;
      }
      else throw new Error('Not a Warcraft Rumble army code.');
    }
    return res;
  };
  const top = fields(0, b.length);
  const slugAt = (i) => {
    const s = table.toSlug.get(i);
    if (!s) throw new Error(`Unknown mini number ${i} in code.`);
    return s;
  };
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

// Draft
const emptyDraft = () => ({ id: null, name: 'New army', leader: null, minis: [null, null, null, null, null, null],
  talents: {}, description: '', tags: [] });

// The name, description and tag fields of an army, the same on the Army and Armory tabs. `attrs` are the field's own
// attributes (id, classes, data-*); every field gets the "keep" class so a redraw doesn't interrupt typing.
const attributes = ({ cls = '', ...rest }) => [`class="keep${cls ? ` ${cls}` : ''}"`,
  ...Object.entries(rest).map(([k, v]) => `${k}="${esc(v)}"`)].join(' ');

export const nameField = (attrs, value, placeholder = 'Name this army') =>
  `<input ${attributes(attrs)} value="${esc(value || '')}" maxlength="${LIMITS.armyName}"
    placeholder="${esc(placeholder)}" aria-label="Army name">`;

export const descriptionField = (attrs, text) =>
  `<textarea ${attributes(attrs)} rows="2" maxlength="${LIMITS.description}"
    placeholder="Description (optional). When to use it, what it counters." aria-label="Army description">${esc(text || '')}</textarea>`;

/**
 * Tag chips with remove buttons (`removeAttr` is the buttons' data attribute) and an input for new tags. With
 * `suggestions` it brings its own suggestion list; without, `listId` names one already on the page.
 */
export function tagEditor(tags, { attrs, removeAttr, listId, suggestions, cls = '' }) {
  const chips = tags.map((t) => `<span class="tag-chip">${esc(t)}<button ${removeAttr}="${esc(t)}"
    aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
  const list = suggestions
    ? `<datalist id="${listId}">${suggestions.filter((t) => !tags.some((x) =>
      x.toLowerCase() === t.toLowerCase())).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`
    : '';
  return `<div class="tag-editor${cls ? ` ${cls}` : ''}" aria-label="Tags">${chips}
    <input ${attributes(attrs)} list="${listId}" maxlength="${LIMITS.tag}"
      placeholder="${tags.length ? 'Add a tag' : 'Tags (optional). Press Enter after each.'}">
    ${list}
  </div>`;
}

/** Tags in use, most used first: the saved armies' (from the server) and the draft's. */
function tagsInUse() {
  const used = (state.armyTags || []).map((t) => t.tag);
  return [...used, ...(builder.draft?.tags || []).filter((t) => !used.some((x) => x.toLowerCase() === t.toLowerCase()))];
}

/**
 * A key in a tag box: Enter or a comma adds the typed tag, Backspace in an empty box removes the last one. Returns the
 * new tags, or null when the key changes nothing.
 */
export function tagKey(e, tags, known) {
  const input = e.target;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const next = withTag(tags, input.value, known);
    input.value = '';
    return next;
  }
  if (e.key === 'Backspace' && !input.value && tags.length) return tags.slice(0, -1);
  return null;
}
// The server keeps the draft (drafts.json, one per account). Saves wait a moment, so typing makes one save.
function loadDraft() {
  const d = state.draft;
  builder.draft = d && Array.isArray(d.minis) ? { ...emptyDraft(), ...d } : emptyDraft();
}

let draftTimer = null;
let draftPending = null;
function saveDraftLocal() {
  draftPending = { account: state.account, draft: JSON.parse(JSON.stringify(builder.draft)) };
  state.draft = draftPending.draft; // keep the local copy current
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}
async function flushDraft() {
  clearTimeout(draftTimer);
  const job = draftPending;
  draftPending = null;
  if (!job) return;
  try {
    await post('/api/draft', job);
  } catch {
    draftPending = draftPending || job;
    draftTimer = setTimeout(flushDraft, 3 * SECOND);
  }
}
// Save the last edit when the page closes.
window.addEventListener('pagehide', () => {
  if (!draftPending) return;
  navigator.sendBeacon?.('/api/draft', new Blob([JSON.stringify(draftPending)], { type: 'application/json' }));
});

/** The unit in slot i of the draft; slot 0 is the leader. */
function draftUnit(i) {
  const d = builder.draft;
  return ownedUnit(i === 0 ? d.leader : d.minis[i - 1]);
}

/** The talent a mini uses in an army: the army's choice, else the first one the player has unlocked, else the first. */
function talentIndex(army, m, u) {
  if (!m?.talents.length) return null;
  const chosen = army.talents?.[m.slug];
  if (Number.isInteger(chosen) && chosen >= 0 && chosen < m.talents.length) return chosen;
  return (u ? effectivePicks(u)[0] : null) ?? 0;
}
const equippedTalent = (u) => talentIndex(builder.draft, miniOf(u), u);

/**
 * An army's slots (the leader first), each with its mini, the player's unit, the level it plays at there and its
 * talent; and the average level and cost, and the minis the account doesn't own.
 */
export function armyStats(army) {
  const leader = ownedUnit(army.leader);
  const slots = [army.leader, ...army.minis].map((slug, i) => {
    const m = slug ? BY_SLUG.get(slug) : null;
    const u = slug ? ownedUnit(slug) : null;
    const lv = leader ? levelInSlot(u, leader, i) : { level: u && !u.synthetic ? u.level : null, match: false, bonus: 0 };
    const ti = talentIndex(army, m, u);
    return { slug, m, u, lv, level: lv.level, bonus: lv.bonus || 0, ti, talent: m && ti != null ? m.talents[ti] : null };
  });
  const filled = slots.filter((s) => s.m);
  const levels = filled.map((s) => s.level).filter((x) => x != null);
  return {
    slots,
    avgLevel: levels.length ? (levels.reduce((x, y) => x + y, 0) / levels.length).toFixed(1) : '–',
    avgCost: filled.length ? (filled.reduce((x, s) => x + s.m.cost, 0) / filled.length).toFixed(1) : '–',
    missing: filled.filter((s) => !s.u).map((s) => s.m.name),
  };
}

// Rendering
function armyToolbar(d) {
  const saved = state.savedArmies || [];
  const options = saved.map((a) => `<option value="${esc(a.id)}"
    ${a.id === d.id ? 'selected' : ''}>${esc(a.name)}${a.tags?.length ? ` · ${esc(a.tags.join(', '))}` : ''}</option>`).join('');
  return `<div class="army-toolbar panel">
    <label>Saved armies <select id="armySaved"><option value="">(unsaved)</option>${options}</select></label>
    ${nameField({ id: 'armyName' }, builder.nameText, d.id ? `Rename "${d.name}"` : 'Name this army')}
    <button class="btn" data-army-action="save">${d.id ? 'Save' : 'Save as new'}</button>
    ${d.id ? '<button class="chip" data-army-action="saveas">Save as copy</button>' : ''}
    <button class="chip" data-army-action="new">New</button>
    ${d.id ? '<button class="chip danger" data-army-action="delete">Delete</button>' : ''}
    <div class="army-meta">
      ${descriptionField({ id: 'armyDesc' }, d.description)}
      ${tagEditor(d.tags || [], { attrs: { id: 'armyTagInput' }, removeAttr: 'data-army-tag-remove', listId: 'armyTagList',
        suggestions: tagsInUse() })}
    </div>
    <span class="code-box">
      <input id="armyCode" class="keep mono" placeholder="Paste a rumblo: army code" aria-label="Army code"
        value="${esc(builder.codeText || '')}">
      <button class="chip" data-army-action="import">Import code</button>
      <button class="chip" data-army-action="export">Copy code</button>
    </span>
    ${builder.codeMsg ? `<span class="small ${builder.codeMsg.ok ? 'cost-ok' : 'cost-no'}">${esc(builder.codeMsg.text)}</span>` : ''}
  </div>`;
}

/** One board slot, with its type and tier from the leader's army board and the mini in it. */
function armySlot(i, s, leader) {
  // Without a leader the slots have no type yet.
  const slot = leader ? armyOf(leader)[i] : { type: i === 0 ? 'Leader' : '', tier: 0, boost: false };
  const tier = RULES.armySlots.tiers[slot.tier];
  const { m, u, lv, ti, talent } = s;
  const typeLabel = i === 0 ? 'Leader' : slot.type || (leader ? 'Type not set' : '–');
  const typeIcon = TAG_ICONS[typeLabel];
  const noSynergy = u && i > 0 && leader && !lv.match;
  const cls = `army-slot tier-${slot.tier}${i === 0 ? ' army-slot-leader' : ''}${u ? '' : ' empty'}${lv.match
    ? ' matched' : ''}${noSynergy ? ' no-synergy' : ''}`;
  const empty = i === 0 ? 'Drop or pick a leader' : leader ? 'Drop or pick a mini' : 'Pick a leader first';
  const level = u && lv.level != null
    ? `<b>${lv.level}</b>${lv.xpMax ? '<span class="max">MAX</span>' : ''}${lv.boosted ? '<span class="max boost">BOOST</span>' : ''}`
    : u ? '<span class="muted">–</span>' : '';
  const talentButton = u && talent
    ? `<button class="army-talent${effectivePicks(u).includes(ti) ? '' : ' locked'}" data-army-talent="${i}"
      title="Talent: ${esc(talent.name)}. Click to choose another.">${ico(talent.icon,
      talent.name).replace('class="ico"', 'class="ico talent-ico"')}</button>`
    : '';
  return `<div class="${cls}" data-army-drop-slot="${i}" style="--tc:${tier.color};--rc:${u ? rarityColor(u.rarity) : 'var(--line)'}">
    <div class="army-slot-head${typeIcon ? ' has-icon' : ''}" title="${esc(typeLabel)} · ${tier.name}${tier.bonus
      ? ` +${tier.bonus}` : ''}${slot.boost ? ' · Boost' : ''}">
      ${typeIcon ? `<span class="medal">${ico(typeIcon, typeLabel)}</span>` : ''}<span
        class="army-slot-label">${esc(typeLabel)}</span>${slot.boost ? '<span class="boost-mark">⚡</span>' : ''}
    </div>
    <button class="army-slot-body" data-army-slot="${i}" ${u && i > 0 ? `draggable="true" data-army-drag-slot="${i}"` : ''}
      aria-label="${u ? `Remove ${esc(m.name)}` : 'Empty slot'}" title="${u ? 'Click to remove it, right-click for details' : ''}">
      ${m ? famFlag(m) : ''}
      ${m ? `<img class="portrait" src="/static/${m.art}" alt="" draggable="false">` : '<span class="add">+</span>'}
      ${m ? `<span class="cost">${m.cost}</span>` : ''}
      ${lv.match && lv.bonus ? `<span class="up" title="Slot bonus +${lv.bonus}">▲${lv.bonus}</span>` : ''}
      ${m ? `<span class="aname">${esc(m.name)}</span>` : `<span class="aname muted">${empty}</span>`}
    </button>
    <div class="army-slot-foot">${level}${talentButton}</div>
    ${builder.talentPop === i && u && talent ? talentPopup(i, u) : ''}
  </div>`;
}

/** Hints under the board about missing slot setup, minis that miss a slot's bonus and minis the account doesn't own. */
function armyNotes(stats, leader) {
  const notes = [];
  if (leader && !leader.army) {
    notes.push(`${esc(miniOf(leader).name)}'s army slots aren't set yet. Set their types and tiers in the leader's panel.`);
  }
  if (leader) {
    stats.slots.forEach((s, i) => {
      if (i === 0 || !s.u || s.u.synthetic) return;
      const slot = armyOf(leader)[i];
      if (!s.lv.match && slot.tier > 0) notes.push(`${esc(s.m.name)} isn't a ${esc(slot.type
        || 'matching')} mini, so it doesn't get this slot's +${RULES.armySlots.tiers[slot.tier].bonus} bonus.`);
    });
  }
  if (stats.missing.length) notes.push(`Not owned on this account: ${stats.missing.map(esc).join(', ')}.`);
  return notes.length ? `<ul class="army-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '';
}

export function renderArmy() {
  if (!state) return;
  if (!builder.draft || builder.draftAccount !== state.account) {
    if (draftPending && draftPending.account !== state.account) flushDraft(); // save the previous account's draft first
    loadDraft();
    builder.draftAccount = state.account;
  }
  const d = builder.draft;
  const leader = draftUnit(0);
  const stats = armyStats(d);
  $('#tab-army').innerHTML = `${armyToolbar(d)}
    <div class="army-wrap panel board-${leader ? String(familiesOf(miniOf(leader))[0]).toLowerCase() : 'neutral'}">
      <div class="army-head">
        <div class="army-stat" title="Average level"><span class="hex">⬢</span>${stats.avgLevel}</div>
        <h2 class="army-title">${leader ? `${esc(miniOf(leader).name)}'s Army` : 'New army'}</h2>
        <div class="army-head-right">
          <div class="army-stat" title="Average gold cost"><span class="gold">●</span>${stats.avgCost}</div>
          <button class="chip danger" data-army-action="clear" title="Remove the leader and all minis">Clear army</button>
        </div>
      </div>
      <div class="army-board">${stats.slots.map((s, i) => armySlot(i, s, leader)).join('')}</div>
      ${armyNotes(stats, leader)}
      <div class="small muted">Drag or click cards to add them, drag between slots to swap, or drag back down to remove.
        A mini's level in a slot is its XP level + rarity + talents, plus the slot's tier bonus if it matches the slot
        type (Wildcard matches all). A Boost slot counts as XP level 20.</div>
    </div>
    <div class="army-pools" data-army-drop-remove>
      <section class="panel pool" id="pool-leaders"></section>
      <section class="panel pool" id="pool-units"></section>
    </div>`;
  renderPool('leaders');
  renderPool('units');
}

// The Leaders and Units & Spells pools.
const POOL_DEFAULT = { leaders: { q: '', fam: [], traits: [], traitMode: 'all', sort: 'level' },
  units: { q: '', fam: [], type: [], traits: [], traitMode: 'all', sort: 'level' } };
function pools() {
  if (!builder.pools) {
    const s = store.get('armyPools', {});
    builder.pools = { leaders: { ...POOL_DEFAULT.leaders, ...s.leaders, q: '' }, units: { ...POOL_DEFAULT.units, ...s.units, q: '' } };
  }
  return builder.pools;
}
const savePools = () => store.set('armyPools', builder.pools);

/** The current leader's slots (1-6) this mini matches, Wildcard slots only when asked for. */
function matchingSlots(m, includeWildcard = false) {
  const L = draftUnit(0);
  if (!L || !m) return [];
  return armyOf(L).map((s, i) => (i > 0 && (includeWildcard || s.type !== 'Wildcard') && slotMatches(s.type, m)
    ? i : null)).filter((x) => x != null);
}

function poolItems(kind) {
  const p = pools()[kind];
  const d = builder.draft;
  const used = new Set([d.leader, ...d.minis].filter(Boolean));
  const q = p.q.trim().toLowerCase();
  const items = state.units
    .map((u) => ({ u, m: miniOf(u) }))
    .filter(({ u, m }) => m && !u.synthetic && (kind === 'leaders' ? m.category === 'Leader' : m.category !== 'Leader'))
    .filter(({ m }) => !q || m.name.toLowerCase().includes(q))
    .filter(({ m }) => !p.fam.length || familiesOf(m).some((f) => p.fam.includes(f)))
    .filter(({ m }) => kind === 'leaders' || !p.type.length || p.type.includes(m.category))
    .filter(({ m }) => !p.traits.length || p.traits[p.traitMode === 'any' ? 'some' : 'every']((t) => m.traits.some((x) => x.name === t)))
    .map((x) => ({ ...x, used: used.has(x.u.slug), level: kind === 'leaders' ? totalLevel(x.u) : x.u.level,
      slots: kind === 'units' ? matchingSlots(x.m) : [] }));
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
  return `<button class="pcard${x.used ? ' used' : ''}${x.slots.length ? ' fits' : ''}" draggable="true"
    data-pool-slug="${u.slug}" data-pool-kind="${kind}" style="--rc:${rarityColor(u.rarity)}"
    title="${esc(m.name)}${tip ? ` · ${tip}` : ''}${x.used ? ' · in this army' : ''}">
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
  const famChips = FAMILIES.map((f) => `<button class="chip small-chip" aria-pressed="${p.fam.includes(f)}"
    data-pool-family="${f}" data-pool="${kind}" title="${f}">${ico(TAG_ICONS[f], f)}</button>`);
  const typeChips = kind === 'units' ? [['Unit', 'Units'], ['Spell', 'Spells']].map(([k, l]) =>
    `<button class="chip small-chip" aria-pressed="${p.type.includes(k)}" data-pool-type="${k}"
    data-pool="${kind}">${l}</button>`).join('') : '';
  const sorts = [['level', 'Level'], ['name', 'Name'], ['cost', 'Cost'], ...(kind === 'units' ? [['match', 'Fits slots']] : [])];
  // traits present in this pool
  const inPane = new Set(state.units.map(miniOf).filter((m) => m
    && (kind === 'leaders' ? m.category === 'Leader' : m.category !== 'Leader')).flatMap((m) => m.traits.map((t) => t.name)));
  const traits = allTraits().filter((t) => inPane.has(t.name));
  const picker = traitPicker({
    scope: kind, traits, filter: p, open: builder.poolTraitOpen === kind, query: builder.poolTraitQ[kind] || '',
    label: `Traits${p.traits.length ? ` (${p.traits.length})` : ''}`, buttonClass: 'chip small-chip',
  });
  el.innerHTML = `<div class="pool-head">
      <h2>${kind === 'leaders' ? 'Leaders' : 'Units & Spells'}</h2>
      <input class="pool-search keep" type="search" data-pool-search="${kind}" placeholder="Search…" value="${esc(p.q)}">
    </div>
    ${(() => {
      const sortSel = `<select data-pool-sort="${kind}" aria-label="Sort">${sorts.map(([k, l]) =>
        `<option value="${k}" ${p.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const active = !!(p.q || p.fam.length || p.type?.length || p.traits.length);
      const clearBtn = `<button class="chip small-chip clear-filters" data-pool-clear="${kind}"
        ${active ? '' : 'disabled'}>✕ Clear filters</button>`;
      if (kind !== 'leaders') return `<div class="pool-filters">${typeChips}${famChips.join('')}${picker}${clearBtn}${sortSel}</div>`;
      // The Leaders pool shows the factions in two rows of three.
      return `<div class="pool-filters pool-filters-rows">
        <div class="pool-filter-row">${famChips.slice(0, 3).join('')}${picker}</div>
        <div class="pool-filter-row">${famChips.slice(3).join('')}${clearBtn}${sortSel}</div>
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
    // Also on first display and on resize.
    if (window.ResizeObserver) new ResizeObserver(() => poolFade(grid)).observe(grid);
  }
  poolFade(grid);
}

/** Marks the pool edges that have more beyond them, which CSS fades. */
function poolFade(grid) {
  const up = grid.scrollTop > 2;
  const down = grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2;
  const more = up && down ? 'both' : up ? 'top' : down ? 'bottom' : '';
  if (grid.dataset.more !== more) grid.dataset.more = more;
}

// Placing minis
function placeLeader(slug) {
  builder.draft.leader = slug;
  saveDraftLocal();
  renderArmy();
}

/** Places a mini in slot i (1-6), swapping if it is already on the board. */
function placeMini(slug, i) {
  const d = builder.draft;
  const prev = d.minis[i - 1];
  const at = d.minis.indexOf(slug);
  if (at >= 0) d.minis[at] = prev;
  d.minis[i - 1] = slug;
  saveDraftLocal();
  renderArmy();
}

/** Adds a pool card. A leader replaces the leader; a mini takes the best empty slot. */
function addFromPool(slug, kind) {
  const d = builder.draft;
  if (kind === 'leaders') return placeLeader(slug);
  if (d.minis.includes(slug)) {
    d.minis[d.minis.indexOf(slug)] = null;
    saveDraftLocal();
    return renderArmy();
  }
  const empty = d.minis.map((s, k) => (s ? null : k + 1)).filter((x) => x != null);
  if (!empty.length) {
    builder.codeMsg = { ok: false, text: 'The army is full. Drag a mini onto a slot to replace it.' };
    return renderArmy();
  }
  // Matching slot first, then Wildcard, then any empty slot.
  const m = miniOf(ownedUnit(slug));
  const fits = matchingSlots(m).filter((i) => empty.includes(i));
  const wild = matchingSlots(m, true).filter((i) => empty.includes(i));
  placeMini(slug, fits[0] ?? wild[0] ?? empty[0]);
}

function swapSlots(a, b) {
  const d = builder.draft;
  [d.minis[a - 1], d.minis[b - 1]] = [d.minis[b - 1], d.minis[a - 1]];
  saveDraftLocal();
  renderArmy();
}

function removeSlot(i) {
  builder.draft.minis[i - 1] = null;
  saveDraftLocal();
  renderArmy();
}

// Talent pop-up
function talentPopup(i, u) {
  const m = miniOf(u);
  const owned = new Set(effectivePicks(u));
  const current = equippedTalent(u);
  return `<div class="talent-pop" role="dialog" aria-label="Choose a talent for ${esc(m.name)}">
    <div class="talent-pop-title">${esc(m.name)}: talent</div>
    ${m.talents.map((t, k) => `<button class="talent-opt${k === current ? ' on' : ''}${owned.has(k) ? '' : ' locked'}"
      data-army-talent-pick="${k}">
      <img src="/static/${t.icon}" alt="">
      <span><b>${esc(t.name)}</b>${owned.has(k) ? '' : ' <small class="muted">(not unlocked)</small>'}<span
        class="small desc">${esc(t.description)}</span></span>
    </button>`).join('')}
  </div>`;
}

// Saving
export async function persistArmies(list) {
  await post('/api/armies', { account: state.account, armies: list });
  await poll();
}

async function armyAction(act) {
  const d = builder.draft;
  const list = [...(state.savedArmies || [])];
  if (act === 'new') { builder.draft = emptyDraft(); builder.nameText = ''; saveDraftLocal(); renderArmy(); return; }
  if (act === 'clear') {
    // Empties the board but keeps the name and the saved army.
    builder.draft = { ...d, leader: null, minis: [null, null, null, null, null, null], talents: {} };
    builder.talentPop = null;
    saveDraftLocal(); renderArmy(); return;
  }
  if (act === 'import') {
    const text = ($('#armyCode')?.value || '').trim();
    builder.codeText = text;
    try {
      const a = await decodeArmyCode(text);
      builder.draft = { ...emptyDraft(), name: 'Imported army', ...a };
      builder.codeMsg = { ok: true, text: 'Army imported.' };
      builder.codeText = ''; // a failed import keeps the text for correction
      saveDraftLocal();
    } catch (err) { builder.codeMsg = { ok: false, text: err.message || 'Could not read that code.' }; }
    renderArmy(); return;
  }
  if (act === 'export') {
    try {
      const code = await encodeArmyCode(d);
      builder.codeText = code;
      builder.codeMsg = { ok: true, text: (await copyText(code)) ? 'Code copied.' : 'Code ready. Copy it from the box.' };
    } catch (err) { builder.codeMsg = { ok: false, text: err.message }; }
    renderArmy(); return;
  }
  if (act === 'delete' && d.id) {
    if (!(await confirmDialog(`"${d.name}" is removed from your saved armies.`,
      { title: 'Delete this army?', ok: 'Delete', danger: true }))) return;
    await persistArmies(list.filter((a) => a.id !== d.id));
    builder.draft = { ...d, id: null };
    saveDraftLocal(); renderArmy(); return;
  }
  if (act === 'save' || act === 'saveas') {
    const id = act === 'save' && d.id ? d.id : `a${Date.now().toString(36)}`;
    // Typed name, else the saved name, else a generated one.
    const typed = ($('#armyName')?.value || '').trim();
    const leaderName = d.leader ? BY_SLUG.get(d.leader)?.name : null;
    const fallback = act === 'save' && d.id ? d.name : `${leaderName ? `${leaderName} army` : 'Army'} ${list.length + 1}`;
    const name = typed || fallback;
    // A tag typed but not confirmed with Enter is kept too.
    d.tags = withTag(d.tags || [], $('#armyTagInput')?.value || '', tagsInUse()) || d.tags || [];
    const entry = { id, name, leader: d.leader, minis: d.minis, talents: d.talents, description: d.description || '', tags: d.tags || [] };
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    await persistArmies(list);
    builder.draft = { ...d, id, name };
    builder.nameText = '';
    builder.codeMsg = { ok: true, text: `Saved "${name}".` };
    saveDraftLocal(); renderArmy();
  }
}

/** Changes a pool's filters, remembers them and redraws the pool. */
function updatePool(kind, change) {
  change(pools()[kind]);
  savePools();
  renderPool(kind);
}

function closePopups() {
  if (builder.talentPop != null) { builder.talentPop = null; renderArmy(); }
}

/** Clicks on a pool's filters and tiles. Returns false when the click wasn't one of them. */
function poolClick(t) {
  const kind = t.dataset.pool;
  if (t.dataset.poolSlug) addFromPool(t.dataset.poolSlug, t.dataset.poolKind);
  else if (t.dataset.poolFamily) updatePool(kind, (p) => toggleIn(p.fam, t.dataset.poolFamily));
  else if (t.dataset.poolType) updatePool(kind, (p) => toggleIn(p.type, t.dataset.poolType));
  else if (t.dataset.poolTrait) updatePool(kind, (p) => toggleIn(p.traits, t.dataset.poolTrait));
  // Clear filters keeps the sort and the trait match mode.
  else if (t.dataset.poolClear) updatePool(t.dataset.poolClear,
    (p) => Object.assign(p, { q: '', fam: [], traits: [], ...(p.type ? { type: [] } : {}) }));
  else return false;
  return true;
}

/** Clicks on the board: slots, talents, tags and the action buttons. */
function boardClick(t) {
  if (t.dataset.armyTagRemove != null) {
    builder.draft.tags = (builder.draft.tags || []).filter((x) => x !== t.dataset.armyTagRemove);
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyTalentPick != null) {
    builder.draft.talents[draftUnit(builder.talentPop).slug] = Number(t.dataset.armyTalentPick);
    builder.talentPop = null;
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyTalent != null) {
    const i = Number(t.dataset.armyTalent);
    builder.talentPop = builder.talentPop === i ? null : i;
    renderArmy();
  } else if (t.dataset.armySlot != null) {
    // Clicking a filled slot empties it.
    const i = Number(t.dataset.armySlot);
    if (!draftUnit(i)) return;
    if (i > 0) return removeSlot(i);
    builder.draft.leader = null;
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyAction) {
    armyAction(t.dataset.armyAction).catch((err) => alertDialog(err.message, { title: 'Something went wrong' }));
  }
}

/** Typing in the tag box (Enter or a comma adds a tag, Backspace in an empty box removes the last), the description and searches. */
function bindTyping(page) {
  page.addEventListener('keydown', (e) => {
    if (e.target.id !== 'armyTagInput') return;
    const next = tagKey(e, builder.draft.tags || [], tagsInUse());
    if (!next) return;
    builder.draft.tags = next;
    saveDraftLocal();
    renderArmy();
    $('#armyTagInput')?.focus();
  });
  page.addEventListener('input', (e) => {
    if (e.target.id === 'armyDesc') {
      builder.draft.description = e.target.value;
      saveDraftLocal(); // saved without a redraw, so typing isn't interrupted
      return;
    }
    const kind = e.target.dataset?.poolSearch;
    if (!kind) return;
    const p = pools()[kind];
    p.q = e.target.value;
    // Only the tiles are redrawn while typing, so Clear filters is updated here.
    renderPoolGrid(kind);
    const clear = $(`#pool-${kind} [data-pool-clear]`);
    if (clear) clear.disabled = !(p.q || p.fam.length || p.type?.length || p.traits.length);
  });
}

/** Dragging minis from the pools onto the board, between slots, or off the board. */
function bindDragAndDrop(page) {
  let drag = null; // { slug, kind: 'leaders'|'units' } or { fromSlot }
  const canDrop = (i) => {
    if (!drag) return false;
    if (drag.fromSlot != null) return i > 0 && i !== drag.fromSlot;
    if (drag.kind === 'leaders') return i === 0;
    return i > 0 && !!draftUnit(0);
  };
  page.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const fromBoard = e.target.closest('[data-army-drag-slot]');
    if (card) drag = { slug: card.dataset.poolSlug, kind: card.dataset.poolKind };
    else if (fromBoard) drag = { fromSlot: Number(fromBoard.dataset.armyDragSlot) };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.slug || `slot:${drag.fromSlot}`);
    page.classList.add('dragging');
    for (const s of page.querySelectorAll('[data-army-drop-slot]')) s.classList.toggle('drop-ok', canDrop(Number(s.dataset.armyDropSlot)));
  });
  page.addEventListener('dragend', () => {
    drag = null;
    page.classList.remove('dragging');
    for (const s of page.querySelectorAll('.drop-ok,.drop-hover')) s.classList.remove('drop-ok', 'drop-hover');
  });
  page.addEventListener('dragover', (e) => {
    const slot = e.target.closest('[data-army-drop-slot]');
    const remove = !slot && drag?.fromSlot != null && e.target.closest('[data-army-drop-remove]');
    if (!(slot && canDrop(Number(slot.dataset.armyDropSlot))) && !remove) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const s of page.querySelectorAll('.drop-hover')) if (s !== slot) s.classList.remove('drop-hover');
    slot?.classList.add('drop-hover');
  });
  page.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const slot = e.target.closest('[data-army-drop-slot]');
    const d = drag;
    drag = null;
    if (slot) {
      const i = Number(slot.dataset.armyDropSlot);
      if (d.fromSlot != null) swapSlots(d.fromSlot, i);
      else if (d.kind === 'leaders') placeLeader(d.slug);
      else placeMini(d.slug, i);
    } else if (d.fromSlot != null) removeSlot(d.fromSlot);
  });
}

// What a click on the Army tab can act on: the board, the talent pop-up, the pools and the tags.
const CLICKABLE = [
  'data-army-slot', 'data-army-talent', 'data-army-talent-pick', 'data-army-action', 'data-pool-slug', 'data-pool-family', 'data-pool-type',
  'data-pool-trait', 'data-pool-clear', 'data-army-tag-remove',
].map((a) => `[${a}]`).join(',');

export function bindArmy() {
  const page = $('#tab-army');
  bindTyping(page);
  bindDragAndDrop(page);
  for (const kind of ['leaders', 'units']) {
    // Opening one pool's picker closes the other's.
    const show = (open) => {
      builder.poolTraitOpen = open ? kind : null;
      builder.poolTraitQ[kind] = '';
      renderPool('leaders');
      renderPool('units');
    };
    bindTraitPicker(page, kind, {
      isOpen: () => builder.poolTraitOpen === kind,
      toggle: () => show(builder.poolTraitOpen !== kind),
      close: () => show(false),
      mode: (mode) => updatePool(kind, (p) => { p.traitMode = mode; }),
      clear: () => updatePool(kind, (p) => { p.traits = []; }),
      tick: (name) => updatePool(kind, (p) => toggleIn(p.traits, name)),
      search: (text) => { builder.poolTraitQ[kind] = text; },
    });
  }
  // right-click opens the mini's details
  page.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const slot = e.target.closest('[data-army-slot]');
    const u = card ? ownedUnit(card.dataset.poolSlug) : slot ? draftUnit(Number(slot.dataset.armySlot)) : null;
    if (!u) return;
    e.preventDefault();
    openDrawer({ kind: 'unit', id: u.id });
  });
  page.addEventListener('click', (e) => {
    // A click outside an open pop-up closes it.
    if (builder.talentPop != null && !e.target.closest('.talent-pop,[data-army-talent]')) { builder.talentPop = null; renderArmy(); }
    const t = e.target.closest(CLICKABLE);
    if (t && !poolClick(t)) boardClick(t);
  });
  page.addEventListener('change', (e) => {
    const d = e.target.dataset || {};
    if (d.poolSort) {
      pools()[d.poolSort].sort = e.target.value;
      savePools();
      renderPoolGrid(d.poolSort);
    } else if (e.target.id === 'armySaved') {
      const saved = (state.savedArmies || []).find((x) => x.id === e.target.value);
      builder.draft = saved ? { ...emptyDraft(), ...structuredClone(saved) } : { ...builder.draft, id: null };
      builder.nameText = '';
      saveDraftLocal();
      renderArmy();
    } else if (e.target.id === 'armyName') {
      builder.nameText = e.target.value; // cleared on save
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopups(); });
}

/** Opens a saved army in the builder (the Armory's Edit). */
export function editArmy(saved) {
  builder.draft = { ...emptyDraft(), ...structuredClone(saved) };
  builder.draftAccount = state.account;
  builder.nameText = '';
  builder.codeMsg = { ok: true, text: `Editing "${saved.name}". Save it to update the Armory.` };
  saveDraftLocal();
}

/** The Armory changed a saved army: the builder's copy follows. */
export function syncDraft(id, change) {
  if (builder.draft?.id !== id) return;
  Object.assign(builder.draft, change);
  saveDraftLocal();
}

/** The Armory deleted a saved army: the builder keeps it as an unsaved army. */
export function detachDraft(id) {
  if (builder.draft?.id !== id) return;
  builder.draft = { ...builder.draft, id: null };
  saveDraftLocal();
}

/** After a restore the draft is loaded again from the restored data. */
export function forgetDraft() { builder.draft = null; }
