'use strict';
// Armory tab: saved armies as cards with inline editing of name, description and tags.
// Depends on globals from app.js and army.js.

ui.armory = { q: '', tags: [] };

/** Level and talent per slot of a saved army. */
function armyStats(a) {
  const L = ownedUnit(a.leader);
  const slugs = [a.leader, ...a.minis];
  const slots = slugs.map((slug, i) => {
    const m = slug ? BY_SLUG.get(slug) : null;
    const u = slug ? ownedUnit(slug) : null;
    const lv = u && L ? levelInSlot(u, L, i) : { level: u && !u.synthetic ? u.level : null, bonus: 0 };
    const t = m && m.talents.length ? (Number.isInteger(a.talents?.[slug]) ? a.talents[slug] : (u ? effectivePicks(u)[0] : null) ?? 0) : null;
    return { slug, m, u, level: lv.level, bonus: lv.bonus || 0, talent: m && t != null ? m.talents[t] : null };
  });
  const filled = slots.filter((s) => s.m);
  const lv = filled.map((s) => s.level).filter((x) => x != null);
  return {
    slots,
    avgLevel: lv.length ? (lv.reduce((x, y) => x + y, 0) / lv.length).toFixed(1) : '–',
    avgCost: filled.length ? (filled.reduce((x, s) => x + s.m.cost, 0) / filled.length).toFixed(1) : '–',
    missing: filled.filter((s) => !s.u).map((s) => s.m.name),
  };
}

function armoryCard(a) {
  const s = armyStats(a);
  const portrait = (x, i) => x.m
    ? `<span class="am-mini${i === 0 ? ' am-leader' : ''}${x.u ? '' : ' missing'}" title="${esc(x.m.name)}${x.level != null ? ` · level ${x.level}` : ''}${x.talent ? ` · ${esc(x.talent.name)}` : ''}${x.u ? '' : ' · not owned'}" style="--rc:${x.u ? rarityColor(x.u.rarity) : 'var(--line)'}">
        <img src="/static/${x.m.art}" alt="">
        ${x.level != null ? `<b>${x.level}</b>` : ''}
        ${x.talent ? `<img class="am-talent" src="/static/${x.talent.icon}" alt="">` : ''}
      </span>`
    : `<span class="am-mini empty${i === 0 ? ' am-leader' : ''}" title="Empty slot">+</span>`;
  return `<article class="panel am-card" data-armory-id="${esc(a.id)}">
    <div class="am-head">
      <input class="am-name keep" data-am-field="name" value="${esc(a.name)}" maxlength="40" aria-label="Army name">
      <span class="army-stat small-stat" title="Average level"><span class="hex">⬢</span>${s.avgLevel}</span>
      <span class="army-stat small-stat" title="Average gold cost"><span class="gold">●</span>${s.avgCost}</span>
    </div>
    <div class="am-minis">${s.slots.map(portrait).join('')}</div>
    ${s.missing.length ? `<div class="small cost-no">Not owned on this account: ${s.missing.map(esc).join(', ')}</div>` : ''}
    <textarea class="am-desc keep" data-am-field="description" rows="2" maxlength="1000" placeholder="Description (optional)" aria-label="Description">${esc(a.description || '')}</textarea>
    <div class="tag-editor am-tags">
      ${(a.tags || []).map((t) => `<span class="tag-chip">${esc(t)}<button data-am-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}
      <input class="am-tag-input keep" list="armoryTagList" placeholder="${(a.tags || []).length ? 'Add tag…' : 'Tags (optional): type and press Enter'}" maxlength="30">
    </div>
    <div class="am-actions">
      <button class="btn" data-am-act="edit">Edit</button>
      <button class="chip" data-am-act="copy">Copy code</button>
      <span class="am-msg small"></span>
      <button class="chip danger am-delete" data-am-act="delete">Delete</button>
    </div>
  </article>`;
}

function armoryFiltered() {
  const q = ui.armory.q.trim().toLowerCase();
  const want = ui.armory.tags.map((t) => t.toLowerCase());
  return (state.savedArmies || []).filter((a) => {
    const tags = (a.tags || []).map((t) => t.toLowerCase());
    if (want.length && !want.every((t) => tags.includes(t))) return false;
    if (!q) return true;
    const minis = [a.leader, ...a.minis].filter(Boolean).map((s) => BY_SLUG.get(s)?.name || '');
    return [a.name, a.description, ...(a.tags || []), ...minis].some((x) => (x || '').toLowerCase().includes(q));
  });
}

function renderArmory() {
  if (!state) return;
  const page = $('#tab-armory');
  const all = state.savedArmies || [];
  const tags = state.armyTags || [];
  ui.armory.tags = ui.armory.tags.filter((t) => tags.some((x) => x.tag.toLowerCase() === t.toLowerCase()));
  const list = armoryFiltered();
  // preserve focus and caret across refreshes
  const active = document.activeElement;
  const focusKey = active?.closest?.('#tab-armory') && active.closest('[data-armory-id]')
    ? { id: active.closest('[data-armory-id]').dataset.armoryId, cls: [...active.classList].find((c) => c.startsWith('am-')), pos: active.selectionStart }
    : null;

  page.innerHTML = `<div class="panel armory-toolbar">
      <h2>Armory <span class="muted small">${all.length} saved arm${all.length === 1 ? 'y' : 'ies'}</span></h2>
      <input id="armorySearch" class="keep" type="search" placeholder="Search names, descriptions, tags, minis…" value="${esc(ui.armory.q)}">
      ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip small-chip" aria-pressed="${ui.armory.tags.some((x) => x.toLowerCase() === t.tag.toLowerCase())}" data-am-filter-tag="${esc(t.tag)}">${esc(t.tag)}<small>${t.count}</small></button>`).join('')}</div>` : ''}
    </div>
    <datalist id="armoryTagList">${tags.map((t) => `<option value="${esc(t.tag)}">`).join('')}</datalist>
    ${all.length === 0
      ? '<div class="panel muted">No saved armies yet. Build one on the Army tab and click Save.</div>'
      : list.length === 0
        ? '<div class="panel muted">No armies match the search or tags.</div>'
        : `<div class="armory-grid">${list.map(armoryCard).join('')}</div>`}`;

  if (focusKey?.cls) {
    const el = page.querySelector(`[data-armory-id="${CSS.escape(focusKey.id)}"] .${focusKey.cls}`);
    if (el) { el.focus(); try { el.setSelectionRange(focusKey.pos, focusKey.pos); } catch { /* not a text field */ } }
  }
}

// ---- editing --------------------------------------------------------------------------------------
async function updateSavedArmy(id, change, card) {
  const list = (state.savedArmies || []).map((a) => (a.id === id ? { ...a, ...change } : a));
  const msg = card?.querySelector('.am-msg');
  try {
    await persistArmies(list);
    // redraw immediately; focus is restored
    renderArmory();
    const m2 = $(`#tab-armory [data-armory-id="${CSS.escape(id)}"] .am-msg`);
    if (m2) { m2.textContent = 'Saved.'; m2.className = 'am-msg small cost-ok'; }
  } catch (err) {
    if (msg) { msg.textContent = `Not saved: ${err.message}`; msg.className = 'am-msg small cost-no'; }
  }
  // keep the Army tab's draft in sync when it is the same army
  if (ui.armyDraft?.id === id) { Object.assign(ui.armyDraft, change); saveDraftLocal(); }
}

function cleanTag(raw) { return String(raw).trim().replace(/\s+/g, ' ').slice(0, 30); }

function bindArmory() {
  const page = $('#tab-armory');
  const armyOfCard = (el) => {
    const card = el.closest('[data-armory-id]');
    return card ? { card, army: (state.savedArmies || []).find((a) => a.id === card.dataset.armoryId) } : {};
  };

  page.addEventListener('input', (e) => {
    if (e.target.id === 'armorySearch') {
      ui.armory.q = e.target.value;
      const caret = e.target.selectionStart;
      renderArmory();
      const s = $('#armorySearch'); s.focus(); s.setSelectionRange(caret, caret);
    }
  });

  // name and description save on blur (and Enter for the name)
  page.addEventListener('change', (e) => {
    const field = e.target.dataset?.amField;
    if (!field) return;
    const { card, army } = armyOfCard(e.target);
    if (!army) return;
    let value = e.target.value;
    if (field === 'name') value = value.trim() || army.name;
    if (value === (army[field] || '')) return;
    updateSavedArmy(army.id, { [field]: value }, card);
  });

  page.addEventListener('keydown', (e) => {
    if (e.target.classList?.contains('am-name') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }
    if (!e.target.classList?.contains('am-tag-input')) return;
    const { card, army } = armyOfCard(e.target);
    if (!army) return;
    const tags = army.tags || [];
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = cleanTag(e.target.value);
      e.target.value = '';
      if (!v || tags.some((t) => t.toLowerCase() === v.toLowerCase()) || tags.length >= 20) return;
      const known = (state.armyTags || []).find((t) => t.tag.toLowerCase() === v.toLowerCase())?.tag;
      updateSavedArmy(army.id, { tags: [...tags, known || v] }, card).then(() => {
        page.querySelector(`[data-armory-id="${CSS.escape(army.id)}"] .am-tag-input`)?.focus();
      });
    } else if (e.key === 'Backspace' && !e.target.value && tags.length) {
      updateSavedArmy(army.id, { tags: tags.slice(0, -1) }, card).then(() => {
        page.querySelector(`[data-armory-id="${CSS.escape(army.id)}"] .am-tag-input`)?.focus();
      });
    }
  });

  page.addEventListener('click', async (e) => {
    const filter = e.target.closest('[data-am-filter-tag]');
    if (filter) { toggleIn(ui.armory.tags, filter.dataset.amFilterTag); return renderArmory(); }
    const rm = e.target.closest('[data-am-tag-remove]');
    if (rm) {
      const { card, army } = armyOfCard(rm);
      return updateSavedArmy(army.id, { tags: (army.tags || []).filter((t) => t !== rm.dataset.amTagRemove) }, card);
    }
    const act = e.target.closest('[data-am-act]');
    if (!act) return;
    const { card, army } = armyOfCard(act);
    if (!army) return;
    const msg = card.querySelector('.am-msg');
    if (act.dataset.amAct === 'edit') {
      ui.armyDraft = { ...emptyDraft(), ...JSON.parse(JSON.stringify(army)) };
      ui.armyDraftAccount = state.account;
      ui.armyNameText = '';
      ui.armyCodeMsg = { ok: true, text: `Editing “${army.name}”. Save to update it in the Armory.` };
      saveDraftLocal();
      setTab('army');
    } else if (act.dataset.amAct === 'copy') {
      try {
        const code = await encodeArmyCode(army);
        let copied = false;
        try { await navigator.clipboard.writeText(code); copied = true; } catch { /* clipboard blocked */ }
        msg.textContent = copied ? 'Code copied.' : code;
        msg.className = `am-msg small ${copied ? 'cost-ok' : 'mono'}`;
      } catch (err) { msg.textContent = err.message; msg.className = 'am-msg small cost-no'; }
    } else if (act.dataset.amAct === 'delete') {
      if (!confirm(`Delete "${army.name}"?`)) return;
      await persistArmies((state.savedArmies || []).filter((a) => a.id !== army.id));
      if (ui.armyDraft?.id === army.id) { ui.armyDraft = { ...ui.armyDraft, id: null }; saveDraftLocal(); }
      renderArmory();
    }
  });
}
