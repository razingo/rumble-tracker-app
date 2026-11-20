// Armory tab: the saved armies as cards, with their name, description and tags editable in place.
import { setTab } from './app.js';
import { encodeArmyCode, nameField, descriptionField, tagEditor, armyStats, persistArmies, editArmy, syncDraft,
  detachDraft } from './army.js';
import { toggleIn } from './collection.js';
import { $, BY_SLUG, state } from './core.js';
import { confirmDialog } from './dialogs.js';
import { esc } from './lib/format.js';
import { withTag } from './lib/limits.js';
import { rarityColor } from './units.js';

// the Armory's search and tag filter
const view = { q: '', tags: [] };

/** Level and talent per slot of a saved army. */
function armoryCard(a) {
  const s = armyStats(a);
  const portrait = (x, i) => x.m
    ? `<span class="am-mini${i === 0 ? ' am-leader' : ''}${x.u ? '' : ' missing'}"
      title="${esc(x.m.name)}${x.level != null ? ` · level ${x.level}` : ''}${x.talent
      ? ` · ${esc(x.talent.name)}` : ''}${x.u ? '' : ' · not owned'}" style="--rc:${x.u ? rarityColor(x.u.rarity) : 'var(--line)'}">
        <img src="/static/${x.m.art}" alt="">
        ${x.level != null ? `<b>${x.level}</b>` : ''}
        ${x.talent ? `<img class="am-talent" src="/static/${x.talent.icon}" alt="">` : ''}
      </span>`
    : `<span class="am-mini empty${i === 0 ? ' am-leader' : ''}" title="Empty slot">+</span>`;
  return `<article class="panel am-card" data-armory-id="${esc(a.id)}">
    <div class="am-head">
      ${nameField({ cls: 'am-name', 'data-am-field': 'name' }, a.name)}
      <span class="army-stat small-stat" title="Average level"><span class="hex">⬢</span>${s.avgLevel}</span>
      <span class="army-stat small-stat" title="Average gold cost"><span class="gold">●</span>${s.avgCost}</span>
    </div>
    <div class="am-minis">${s.slots.map(portrait).join('')}</div>
    ${s.missing.length ? `<div class="small cost-no">Not owned on this account: ${s.missing.map(esc).join(', ')}</div>` : ''}
    ${descriptionField({ cls: 'am-desc', 'data-am-field': 'description' }, a.description)}
    ${tagEditor(a.tags || [], { attrs: { cls: 'am-tag-input' }, removeAttr: 'data-am-tag-remove',
      listId: 'armoryTagList', cls: 'am-tags' })}
    <div class="am-actions">
      <button class="btn" data-am-act="edit">Edit</button>
      <button class="chip" data-am-act="copy">Copy code</button>
      <span class="am-msg small"></span>
      <button class="chip danger am-delete" data-am-act="delete">Delete</button>
    </div>
  </article>`;
}

function armoryFiltered() {
  const q = view.q.trim().toLowerCase();
  const want = view.tags.map((t) => t.toLowerCase());
  return (state.savedArmies || []).filter((a) => {
    const tags = (a.tags || []).map((t) => t.toLowerCase());
    if (want.length && !want.every((t) => tags.includes(t))) return false;
    if (!q) return true;
    const minis = [a.leader, ...a.minis].filter(Boolean).map((s) => BY_SLUG.get(s)?.name || '');
    return [a.name, a.description, ...(a.tags || []), ...minis].some((x) => (x || '').toLowerCase().includes(q));
  });
}

export function renderArmory() {
  if (!state) return;
  const page = $('#tab-armory');
  const all = state.savedArmies || [];
  const tags = state.armyTags || [];
  view.tags = view.tags.filter((t) => tags.some((x) => x.tag.toLowerCase() === t.toLowerCase()));
  const list = armoryFiltered();
  // keep the focus and caret across redraws
  const active = document.activeElement;
  const focusKey = active?.closest?.('#tab-armory') && active.closest('[data-armory-id]')
    ? { id: active.closest('[data-armory-id]').dataset.armoryId,
      cls: [...active.classList].find((c) => c.startsWith('am-')), pos: active.selectionStart }
    : null;

  page.innerHTML = `<div class="panel armory-toolbar">
      <h2>Armory <span class="muted small">${all.length} saved arm${all.length === 1 ? 'y' : 'ies'}</span></h2>
      <input id="armorySearch" class="keep" type="search" placeholder="Search names, descriptions, tags, minis…" value="${esc(view.q)}">
      ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip small-chip"
        aria-pressed="${view.tags.some((x) => x.toLowerCase() === t.tag.toLowerCase())}"
        data-am-filter-tag="${esc(t.tag)}">${esc(t.tag)}<small>${t.count}</small></button>`).join('')}</div>` : ''}
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

async function updateSavedArmy(id, change, card) {
  const list = (state.savedArmies || []).map((a) => (a.id === id ? { ...a, ...change } : a));
  const msg = card?.querySelector('.am-msg');
  try {
    await persistArmies(list);
    // redraw at once; the focus is restored
    renderArmory();
    const m2 = $(`#tab-armory [data-armory-id="${CSS.escape(id)}"] .am-msg`);
    if (m2) { m2.textContent = 'Saved.'; m2.className = 'am-msg small cost-ok'; }
  } catch (err) {
    if (msg) { msg.textContent = `Not saved. ${err.message}`; msg.className = 'am-msg small cost-no'; }
  }
  syncDraft(id, change);
}

export function bindArmory() {
  const page = $('#tab-armory');
  const armyOfCard = (el) => {
    const card = el.closest('[data-armory-id]');
    return card ? { card, army: (state.savedArmies || []).find((a) => a.id === card.dataset.armoryId) } : {};
  };

  page.addEventListener('input', (e) => {
    if (e.target.id === 'armorySearch') {
      view.q = e.target.value;
      const caret = e.target.selectionStart;
      renderArmory();
      const s = $('#armorySearch'); s.focus(); s.setSelectionRange(caret, caret);
    }
  });

  // the name and description are saved when the field loses focus, the name also on Enter
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
      const next = withTag(tags, e.target.value, (state.armyTags || []).map((t) => t.tag));
      e.target.value = '';
      if (!next) return;
      updateSavedArmy(army.id, { tags: next }, card).then(() => {
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
    if (filter) { toggleIn(view.tags, filter.dataset.amFilterTag); return renderArmory(); }
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
      editArmy(army);
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
      if (!(await confirmDialog(`"${army.name}" is removed from your saved armies.`,
        { title: 'Delete this army?', ok: 'Delete', danger: true }))) return;
      await persistArmies((state.savedArmies || []).filter((a) => a.id !== army.id));
      detachDraft(army.id);
      renderArmory();
    }
  });
}
