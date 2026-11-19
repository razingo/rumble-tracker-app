// The side panel for one mini: stats, talents, the unit's mini assignment and (leaders) army slots.
import { alertDialog } from './dialogs.js';
import { poll } from './app.js';
import { miniOptions } from './collection.js';
import { $, esc, fmt, post, RULES, BY_SLUG, TAG_ICONS, state, ui } from './core.js';
import { rarityName, rarityColor, miniOf, unitName, balance, curName, coreName, nextUpgrade, talentSlots, allTalentsOwned, effectivePicks, xpToMax, isLeader, fixedSlot, slotLocked, bottomSlotOptions, armyOf, leaderSlotBonus, totalLevel, armyTotals } from './units.js';

// ---- detail drawer ---------------------------------------------------------------------
export const ico = (path, title = '') => (path ? `<img class="ico" src="/static/${path}" alt="" title="${esc(title)}">` : '');
export const tag = (name) => `<span class="tag-pill">${ico(TAG_ICONS[name], name)}${esc(name)}</span>`;
export function statRows(m, level) {
  return Object.entries(m.stats).map(([k, v]) => {
    const val = Array.isArray(v) ? v[Math.min(v.length, level) - 1] : v;
    return `<tr><td>${esc(k)}</td><td>${esc(typeof val === 'number' ? fmt(val) : val)}</td></tr>`;
  }).join('');
}

export function armyEditor(u, m) {
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

export async function saveArmy(u, slots) {
  try {
    await post('/api/army', { account: state.account, unitId: u.id, slots });
    u.army = slots;
    await poll();
    renderDrawer();
  } catch (err) { alertDialog(err.message, { title: 'Not saved' }); }
}

export function renderDrawer() {
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

export function openDrawer(open) {
  ui.open = open;
  ui.previewLevel = null;
  renderDrawer();
}
export function closeDrawer() {
  ui.open = null;
  delete $('.drawer-body').dataset.key;
  $('#drawer').hidden = true;
}

// ---- events ----------------------------------------------------------------------------
export async function saveUnitName(id, select) {
  if (!select.value) return;
  try {
    await post('/api/name', { kind: 'unit', id, value: select.value });
    await poll();
  } catch (e) { alertDialog(e.message, { title: 'Not saved' }); }
}
