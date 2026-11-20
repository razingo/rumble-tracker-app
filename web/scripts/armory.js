// Armory tab: the saved armies as cards, with their name, description and tags editable in place.
import { setTab } from './app.js';
import { encodeArmyCode } from './army-code.js';
import { nameField, descriptionField, tagEditor, armyStats, persistArmies, editArmy, syncDraft, detachDraft } from './army.js';
import { toggleIn } from './collection.js';
import { $, showMessage, copyText, BY_SLUG, state } from './core.js';
import { confirmDialog } from './dialogs.js';
import { esc, plural } from './lib/format.js';
import { tagKey } from './lib/limits.js';
import { rarityColor } from './units.js';

// The Armory's search and tag filter.
const view = { q: '', tags: [] };

/** Level and talent per slot of a saved army. */
function armoryCard(a) {
  const s = armyStats(a);
  const portrait = (x, i) => x.m
    ? `<span class="armory-mini${i === 0 ? ' armory-leader' : ''}${x.u ? '' : ' missing'}"
      title="${esc(x.m.name)}${x.level != null ? ` · level ${x.level}` : ''}${x.talent
      ? ` · ${esc(x.talent.name)}` : ''}${x.u ? '' : ' · not owned'}"
        style="--rarity-color:${x.u ? rarityColor(x.u.rarity) : 'var(--line)'}">
        <img src="/static/${x.m.art}" alt="">
        ${x.level != null ? `<b>${x.level}</b>` : ''}
        ${x.talent ? `<img class="armory-talent" src="/static/${x.talent.icon}" alt="">` : ''}
      </span>`
    : `<span class="armory-mini empty${i === 0 ? ' armory-leader' : ''}" title="Empty slot">+</span>`;
  return `<article class="panel armory-card" data-armory-id="${esc(a.id)}">
    <div class="armory-head">
      ${nameField({ cls: 'armory-name', 'data-armory-field': 'name' }, a.name)}
      <span class="army-stat small-stat" title="Average level"><span class="hex">⬢</span>${s.avgLevel}</span>
      <span class="army-stat small-stat" title="Average gold cost"><span class="gold">●</span>${s.avgCost}</span>
    </div>
    <div class="armory-minis">${s.slots.map(portrait).join('')}</div>
    ${s.missing.length ? `<div class="small text-warn">Not owned on this account: ${s.missing.map(esc).join(', ')}</div>` : ''}
    ${descriptionField({ cls: 'armory-desc', 'data-armory-field': 'description' }, a.description)}
    ${tagEditor(a.tags || [], { attrs: { cls: 'armory-tag-input' }, removeAttr: 'data-armory-tag-remove',
      listId: 'armoryTagList', cls: 'armory-tags' })}
    <div class="armory-actions">
      <button class="button" data-armory-action="edit">Edit</button>
      <button class="chip" data-armory-action="copy">Copy code</button>
      <span class="armory-message small"></span>
      <button class="chip danger armory-delete" data-armory-action="delete">Delete</button>
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
  // Keep the focus and caret across redraws.
  const active = document.activeElement;
  const focusKey = active?.closest?.('#tab-armory') && active.closest('[data-armory-id]')
    ? { id: active.closest('[data-armory-id]').dataset.armoryId,
      cls: [...active.classList].find((c) => c.startsWith('armory-')), pos: active.selectionStart }
    : null;

  page.innerHTML = `<div class="panel armory-toolbar">
      <h2>Armory <span class="muted small">${plural(all.length, 'saved army', 'saved armies')}</span></h2>
      <input id="armorySearch" class="keep" type="search" placeholder="Search names, descriptions, tags, minis…" value="${esc(view.q)}">
      ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip small-chip"
        aria-pressed="${view.tags.some((x) => x.toLowerCase() === t.tag.toLowerCase())}"
        data-armory-tag-filter="${esc(t.tag)}">${esc(t.tag)}<small>${t.count}</small></button>`).join('')}</div>` : ''}
    </div>
    <datalist id="armoryTagList">${tags.map((t) => `<option value="${esc(t.tag)}">`).join('')}</datalist>
    ${all.length === 0
      ? '<div class="panel muted">No saved armies yet. Build one on the Army tab and click Save.</div>'
      : list.length === 0
        ? '<div class="panel muted">No armies match the search or tags.</div>'
        : `<div class="armory-grid">${list.map(armoryCard).join('')}</div>`}`;

  if (focusKey?.cls) {
    const el = page.querySelector(`[data-armory-id="${CSS.escape(focusKey.id)}"] .${focusKey.cls}`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(focusKey.pos, focusKey.pos);
      } catch {
        // not a text field
      }
    }
  }
}

async function updateSavedArmy(id, change, card) {
  const list = (state.savedArmies || []).map((a) => (a.id === id ? { ...a, ...change } : a));
  const msg = card?.querySelector('.armory-message');
  try {
    await persistArmies(list);
    // Redraw at once; the focus is restored.
    renderArmory();
    const m2 = $(`#tab-armory [data-armory-id="${CSS.escape(id)}"] .armory-message`);
    showMessage(m2, 'Saved.', 'good');
  } catch (err) {
    showMessage(msg, `Not saved. ${err.message}`, 'warn');
  }
  syncDraft(id, change);
}

/** The card an element is in, and its saved army. */
function armyOfCard(el) {
  const card = el.closest('[data-armory-id]');
  return card ? { card, army: (state.savedArmies || []).find((a) => a.id === card.dataset.armoryId) } : {};
}

/** Redraws on every key in the search, keeping the caret. */
function searchInput(e) {
  if (e.target.id !== 'armorySearch') return;
  view.q = e.target.value;
  const caret = e.target.selectionStart;
  renderArmory();
  const search = $('#armorySearch');
  search.focus();
  search.setSelectionRange(caret, caret);
}

/** The name and description are saved when the field loses focus, and the name also on Enter. */
function fieldChange(e) {
  const field = e.target.dataset?.armoryField;
  if (!field) return;
  const { card, army } = armyOfCard(e.target);
  if (!army) return;
  let value = e.target.value;
  if (field === 'name') value = value.trim() || army.name;
  if (value === (army[field] || '')) return;
  updateSavedArmy(army.id, { [field]: value }, card);
}

function cardKeys(e) {
  if (e.target.classList?.contains('armory-name') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
    return;
  }
  if (!e.target.classList?.contains('armory-tag-input')) return;
  const { card, army } = armyOfCard(e.target);
  if (!army) return;
  const next = tagKey(e, army.tags || [], (state.armyTags || []).map((t) => t.tag));
  if (!next) return;
  updateSavedArmy(army.id, { tags: next }, card).then(() => {
    $(`#tab-armory [data-armory-id="${CSS.escape(army.id)}"] .armory-tag-input`)?.focus();
  });
}

async function copyCode(army, msg) {
  try {
    const code = await encodeArmyCode(army);
    const copied = await copyText(code);
    showMessage(msg, copied ? 'Code copied.' : code, copied ? 'good' : 'code');
  } catch (err) {
    showMessage(msg, err.message, 'warn');
  }
}

async function deleteArmy(army) {
  const ok = await confirmDialog(`"${army.name}" is removed from your saved armies.`,
    { title: 'Delete this army?', ok: 'Delete', danger: true });
  if (!ok) return;
  await persistArmies((state.savedArmies || []).filter((a) => a.id !== army.id));
  detachDraft(army.id);
  renderArmory();
}

async function cardClick(e) {
  const filter = e.target.closest('[data-armory-tag-filter]');
  if (filter) {
    toggleIn(view.tags, filter.dataset.armoryTagFilter);
    return renderArmory();
  }
  const remove = e.target.closest('[data-armory-tag-remove]');
  if (remove) {
    const { card, army } = armyOfCard(remove);
    return updateSavedArmy(army.id, { tags: (army.tags || []).filter((t) => t !== remove.dataset.armoryTagRemove) }, card);
  }
  const act = e.target.closest('[data-armory-action]');
  if (!act) return;
  const { card, army } = armyOfCard(act);
  if (!army) return;
  if (act.dataset.armoryAction === 'edit') {
    editArmy(army);
    setTab('army');
  } else if (act.dataset.armoryAction === 'copy') await copyCode(army, card.querySelector('.armory-message'));
  else if (act.dataset.armoryAction === 'delete') await deleteArmy(army);
}

export function bindArmory() {
  const page = $('#tab-armory');
  page.addEventListener('input', searchInput);
  page.addEventListener('change', fieldChange);
  page.addEventListener('keydown', cardKeys);
  page.addEventListener('click', cardClick);
}
