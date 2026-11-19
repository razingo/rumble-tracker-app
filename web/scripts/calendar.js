'use strict';
// Calendar tab: event schedules from gamedata/events.json plus the events the save reports as running.
// Depends on globals from app.js.

let EVENTS = null; // { currencies: { A|B|C: saveId }, rotations: [...], events: [...] }
// offset: timeline shift in days; tree: event whose reward tree is open; picks: selected rewards ("row-col" keys)
ui.calendar = { offset: 0, tree: null, picks: [] };
// event ticket currencies (save IDs, also in events.json)
const EVENT_CURRENCY = { A: 'd43f55f20c6d9817715855e9601e9228', B: 'c4bb4c360d9e33ead30322d8d630ef79', C: '94c293ba0152633a5a74a8dae8dab0ba' };
const EVENT_CURRENCY_IDS = new Set(Object.values(EVENT_CURRENCY));

const DAY = 86400000;
const EVENT_ICON = new Set(['darkmoon', 'pilgrim', 'solo', 'winterveil', 'hallow', 'arthas', 'family', 'love', 'newyear']);
const eventIcon = (ev) => `/static/events/${EVENT_ICON.has(ev.family) ? ev.family : 'generic'}.webp`;
const TIMELINE_DAYS = 35; // centred on today
const TIMELINE_RANGE = 120; // slider range in days, each way
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;

async function loadEvents() {
  if (EVENTS) return EVENTS;
  EVENTS = await fetch('/static/events.json').then((r) => r.json());
  return EVENTS;
}

// ---- schedules ------------------------------------------------------------------------------------
/** UTC time of the n-th weekday of a month at the given hour. */
function nthWeekdayUtc(y, m0, nth, weekday, hour) {
  const first = new Date(Date.UTC(y, m0, 1)).getUTCDay();
  return Date.UTC(y, m0, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7, hour);
}

/** Every run of an event overlapping [from, to): [{ start, end }] in ms. */
function occurrences(ev, from, to) {
  const s = ev.schedule;
  const out = [];
  if (s.kind === 'once') {
    const a = Date.parse(s.start), b = Date.parse(s.end);
    if (b > from && a < to) out.push({ start: a, end: b });
    return out;
  }
  const until = s.until ? Date.parse(`${s.until}T23:59:59Z`) : Infinity;
  const y0 = Math.max(s.fromYear, new Date(from).getUTCFullYear() - 1);
  const y1 = new Date(to).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    const months = s.every === 'month'
      ? [...Array(12).keys()].filter((m) => y > s.fromYear || m >= s.month - 1)
      : [s.month - 1];
    for (const m of months) {
      const a = s.kind === 'nthWeekday' ? nthWeekdayUtc(y, m, s.nth, s.weekday, s.hourUtc) : Date.UTC(y, m, s.day, s.hourUtc);
      const b = a + s.days * DAY;
      if (a <= until && b > from && a < to) out.push({ start: a, end: b });
    }
  }
  return out;
}

function runsBetween(from, to) {
  return EVENTS.events.flatMap((ev) => occurrences(ev, from, to).map((o) => ({ ev, ...o })));
}

/** "2nd Wednesday of every month · 7 days" */
function ruleText(s) {
  if (s.kind === 'once') return null;
  const when = s.kind === 'nthWeekday'
    ? `${ordinal(s.nth)} ${WEEKDAY_NAMES[s.weekday]} of ${s.every === 'month' ? 'every month' : MONTH_NAMES[s.month - 1]}`
    : `${s.every === 'month' ? 'Every month on the' : `${MONTH_NAMES[s.month - 1]}`} ${ordinal(s.day)}`;
  return `${when} · ${s.days} days`;
}

// ---- formatting -----------------------------------------------------------------------------------
function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${min}m`;
  return `${min}m`;
}
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayOnly = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const isLive = (ev) => (state?.activeEvents || []).includes(ev.saveId);
// tickets reset between events: a balance belongs to the event using its slot now
function ticketBalance(ev) {
  const id = ev.currency && EVENT_CURRENCY[ev.currency];
  const c = id && state?.currencies?.find((x) => x.id === id);
  return c && c.event === (ev.name || ev.id) ? c.balance : null;
}

// ---- dungeon / raid rotations ---------------------------------------------------------------------
/** The rotation entry active at time t: { item, start, end }. */
function rotationAt(rot, t) {
  const t0 = Date.parse(rot.start), p = rot.periodDays * DAY;
  const k = Math.floor((t - t0) / p);
  const n = rot.list.length;
  return { item: rot.list[((k % n) + n) % n], start: t0 + k * p, end: t0 + (k + 1) * p };
}
const rotName = (item) => (typeof item === 'string' ? item : `${item.name}${item.type === 'Siege' ? ' Siege' : ''}`);
const rotColor = (rot, item) => (rot.id === 'dungeonFamily' ? `var(--fam-${String(item).toLowerCase()}, var(--ev-default))` : rot.id === 'raid' ? (item.type === 'Siege' ? 'var(--ev-siege)' : 'var(--ev-raid)') : 'var(--ev-dungeon)');
const rotIcon = (rot, item) => (rot.id === 'dungeonFamily' && TAG_ICONS?.[item] ? `<img class="rot-ico" src="/static/${TAG_ICONS[item]}" alt="">` : '');

/** The account's Ankh (continues a failed dungeon), on the Dungeon card. */
function ankhLine() {
  const c = state?.currencies?.find((x) => x.id === ANKH_ID);
  const icon = RULES.currencyIcons?.[ANKH_ID];
  return `<div class="rot-ankh" title="Used to continue failed dungeons">${icon ? `<img class="cur-ico" src="/static/${icon}" alt="">` : ''}${esc(c?.name || 'Ankh')} <b>${fmt(c?.balance ?? 0)}</b> <small class="muted">continues a failed dungeon</small></div>`;
}

function renderRotations(now) {
  const card = (rot) => {
    const cur = rotationAt(rot, now);
    const next = [1, 2, 3].map((k) => rotationAt(rot, cur.end + (k - 1) * rot.periodDays * DAY));
    return `<article class="rot-card" style="--ev:${rotColor(rot, cur.item)}">
      <div class="rot-label">${esc(rot.label)} <span class="muted">· every ${rot.periodDays === 7 ? 'week' : `${rot.periodDays / 7} weeks`}</span></div>
      <div class="rot-now">${rotIcon(rot, cur.item)}<b>${esc(rotName(cur.item))}</b></div>
      <div class="cal-when">Changes in ${span(cur.end - now)}</div>
      ${rot.id === 'dungeon' ? ankhLine() : ''}
      <div class="rot-next">${next.map((x) => `<span title="${esc(when(x.start))}">${rotIcon(rot, x.item)}${esc(rotName(x.item))} <small>${esc(dayOnly(x.start))}</small></span>`).join('')}</div>
    </article>`;
  };
  return `<section class="panel">
    <div class="cal-head"><h2>Dungeons, raids &amp; sieges</h2><span class="muted small">Rotations from the game files</span></div>
    <div class="cal-cards">${(EVENTS.rotations || []).map(card).join('')}</div>
  </section>`;
}

// ---- shop offers ----------------------------------------------------------------------------------
// Timed store slots and limited offers from the save; titles and prices from static/store.json.
// Permanent packs have no timer and are not listed.
const titleCase = (s) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s") : s);
// the tome an offer sells: from the save, or parsed from generic offer names
function offerTome(o) {
  if (o.tome && STORE?.tomes?.[o.tome]) return STORE.tomes[o.tome];
  const m = /Tome(Modest|Major|Mega|Mythic)(?:_(\w+?))?_StoreOffer/.exec(STORE?.offers?.[o.offer]?.name || '');
  return m ? `${m[1]} ${m[2] && !/Generic/.test(m[2]) ? `${m[2]} ` : ''}Tome` : null;
}
// tome name -> icon (static/rewards)
function tomeIcon(name) {
  const m = /^(Modest|Major|Mega|Mythic)(?: (\w+))? Tome$/.exec(name || '');
  return m ? `/static/rewards/Shared_Tex_Tome${m[1]}_${m[2] || 'Generic'}.webp` : null;
}
function offerTitle(o) {
  const info = STORE?.offers?.[o.offer];
  const minis = (o.slugs || []).map((s) => BY_SLUG.get(s)?.name).filter(Boolean);
  let t = info?.title || 'Offer';
  t = t.replace('{mini}', minis.join(' + ') || 'Mini').replace('{tome}', offerTome(o) || 'Tome');
  return titleCase(t);
}
function renderShopOffers(now) {
  const shop = state?.shop;
  if (!shop || !STORE) return '';
  const timed = [...shop.offers.filter((o) => o.expires && Date.parse(o.expires) > now - 60000), ...shop.limited.filter((o) => o.expires && Date.parse(o.expires) > now - 60000)]
    .sort((a, b) => Date.parse(a.expires) - Date.parse(b.expires));
  if (!timed.length) return '';
  const card = (o) => {
    const info = STORE.offers[o.offer] || {};
    const isFree = /^FreeGift/.test(info.name || '');
    const price = isFree ? 'Free' : info.cost ? `${fmt(info.cost.amount)} ${info.cost.coins ? '<span class="gold">●</span>' : esc(info.cost.currency || '')}` : info.realMoney ? 'Real money' : '';
    const minis = (o.slugs || []).map((s) => s && BY_SLUG.get(s)).filter(Boolean);
    // art: offered minis, else the tome, else the offer banner
    const tIcon = o.tome ? tomeIcon(offerTome(o)) : null;
    const art = minis.length ? minis.slice(0, 2).map((m) => `<img src="/static/${m.art}" alt="">`).join('')
      : tIcon ? `<img class="tome" src="${tIcon}" alt="">`
        : info.icon ? `<img class="tome" src="/static/store/${encodeURIComponent(info.icon)}.webp" alt="">`
          : `<span>${isFree ? '🎁' : '◆'}</span>`;
    return `<article class="shop-card">
      <div class="shop-art">${art}</div>
      <div class="shop-body">
        <div class="cal-name">${esc(offerTitle(o))}</div>
        <div class="cal-when">${isFree ? 'Next free gift in' : /Siege|Chain/i.test(info.name || '') ? 'Ends in' : 'Resets in'} ${esc(span(Date.parse(o.expires) - now))}</div>
        <div class="cal-dates">${esc(when(Date.parse(o.expires)))}${price ? ` · ${price}` : ''}</div>
      </div>
    </article>`;
  };
  // order: Daily_* (free gift first), Special_*, others
  const nameOf = (o) => STORE.offers[o.offer]?.name || '';
  const groups = [
    ['Daily offers', timed.filter((o) => /^(FreeGift|Daily)_/.test(nameOf(o))).sort((a, b) => /^FreeGift/.test(nameOf(b)) - /^FreeGift/.test(nameOf(a)))],
    ['Special offers', timed.filter((o) => /^Special_/.test(nameOf(o)))],
    ['Other offers', timed.filter((o) => !/^(FreeGift|Daily|Special)_/.test(nameOf(o)))],
  ].filter(([, list]) => list.length);
  return `<section class="panel">
    <div class="cal-head"><h2>Shop offers</h2><span class="muted small">From your save · daily offers reset at 18:00 UTC</span></div>
    ${groups.map(([title, list]) => `<h3 class="shop-group">${title}</h3><div class="cal-cards shop-cards">${list.map(card).join('')}</div>`).join('')}
  </section>`;
}

// ---- event currencies -----------------------------------------------------------------------------
function renderTickets(now) {
  const soon = runsBetween(now - DAY, now + 60 * DAY).sort((a, b) => a.start - b.start);
  const chips = Object.entries(EVENT_CURRENCY).map(([k, id]) => {
    const c = state?.currencies?.find((x) => x.id === id);
    const runs = soon.filter((r) => r.ev.currency === k && r.end > now);
    const users = [...new Set(runs.map((r) => r.ev.name || r.ev.id))].slice(0, 3);
    // icon of the current or next event using these tickets
    const icon = RULES.currencyIcons?.[id] ? `/static/${RULES.currencyIcons[id]}` : runs[0] ? eventIcon(runs[0].ev) : null;
    // between events the slot is idle: its old balance resets when the next event starts
    const name = c?.name || 'Event tickets';
    const idle = !c?.event;
    const next = users.filter((u) => u !== c?.event);
    return `<div class="cur${idle ? ' idle' : ''}" title="${esc(name)}${idle ? ' · no event is using these tickets now' : ''}">
      ${icon ? `<img class="cur-ico" src="${icon}" alt="">` : ''}<span>${esc(name)}</span><b>${idle ? '–' : fmt(c?.balance ?? 0)}</b>
      ${next.length ? `<small class="muted">next: ${esc(next.join(', '))}</small>` : ''}</div>`;
  }).join('');
  return `<div class="currencies cal-tickets">${chips}</div>`;
}

// ---- reward tree ----------------------------------------------------------------------------------
function rewardImg(r, ev) {
  const art = r.mini && BY_SLUG.get(r.mini)?.art;
  const src = art ? `/static/${art}` : r.icon ? `/static/rewards/${encodeURIComponent(r.icon)}.webp` : eventIcon(ev);
  return `<img class="${art ? 'mini-art' : ''}" src="${esc(src)}" alt="" data-fallback="${esc(eventIcon(ev))}">`;
}
// images fall back once to data-fallback (inline handlers are blocked by the CSP)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.dataset.fallback) { const f = img.dataset.fallback; delete img.dataset.fallback; img.src = f; }
}, true);
/** Extra coin percentage from owned income bonuses. */
function coinBonusPercent() {
  return (state?.incomeBonuses || []).reduce((s, id) => s + (EVENTS.incomeBonuses?.[id]?.coinsPercent || 0), 0);
}
/** The event's challenges (ticket sources), collapsed by default. */
function renderChallenges(ev) {
  const groups = ev.challenges || [];
  if (!groups.length) return '';
  const count = groups.reduce((s, g) => s + g.challenges.length, 0);
  const steps = (c) => (c.steps.length > 1
    ? `<span class="ch-steps">${c.steps.map((x) => `<span title="${esc(x.title)}">${fmt(x.target)} → ${fmt(x.tickets)}</span>`).join('')}</span>`
    : c.steps[0] && c.steps[0].target > 1 ? `<span class="ch-steps"><span>${fmt(c.steps[0].target)} → ${fmt(c.steps[0].tickets)}</span></span>` : '');
  const item = (c) => `<li><span class="ch-title">${esc(c.title)}</span>${steps(c)}<b>${fmt(c.total)}</b></li>`;
  const head = (g) => g.kind === 'daily' ? `Daily challenges · ${g.active} a day from ${g.poolSize}, about ${fmt(g.perDay)} tickets a day`
    : g.kind === 'weekly' ? `Weekly challenge${g.challenges.length > 1 ? 's' : ''}` : `Event challenges · ${g.challenges.length}`;
  return `<details class="tree-challenges" ${ui.calendar.chOpen ? 'open' : ''}>
    <summary>Challenges <span class="muted small">${count} · ${fmt(ev.challengeTickets || 0)} tickets in total</span></summary>
    ${groups.map((g) => `<h4>${head(g)}</h4><ul class="ch-list${g.kind === 'daily' ? ' pool' : ''}">${g.challenges.map(item).join('')}</ul>`).join('')}
  </details>`;
}

/** Days left and remaining daily-challenge tickets for a running event. */
function dailiesLeft(ev, now) {
  const run = occurrences(ev, now, now + 1)[0];
  const daily = (ev.challenges || []).find((g) => g.kind === 'daily');
  if (!run || !daily) return null;
  const days = Math.max(0, Math.ceil((run.end - now) / DAY));
  return { days, tickets: days * daily.perDay, perDay: daily.perDay };
}

function renderRewardTree(ev) {
  const R = ev.rewards || [];
  if (!R.length) return '';
  const bonus = coinBonusPercent();
  const coinAmount = (r) => (r.coins && bonus ? Math.round(r.amount * (1 + bonus / 100)) : r.amount);
  const rows = Math.max(...R.map((r) => r.row)) + 1;
  // Rewards are positioned by column (Col1..ColN); trees mix staggered and straight rows, so positions are exact.
  const N = Math.max(...R.map((r) => r.col)) + 1;
  // Links come from r.requires ("row-col" keys): no requirements means unlocked; otherwise any one requirement
  // unlocks it, or all of them when r.requireAll.
  const key = (r) => `${r.row}-${r.col}`;
  const byKey = new Map(R.map((r) => [key(r), r]));
  const reqs = (r) => (r.requires || []).map((k) => byKey.get(k)).filter(Boolean);
  const sorted = [...R].sort((a, b) => a.row - b.row || a.col - b.col);
  // requirements first (they can share a row)
  const topo = [];
  { const done = new Set(); const visit = (r, seen = new Set()) => { if (done.has(r) || seen.has(r)) return; seen.add(r); reqs(r).forEach((p) => visit(p, seen)); done.add(r); topo.push(r); }; sorted.forEach((r) => visit(r)); }
  // Cheapest set of rewards that unlocks every selected reward, paying shared requirements once.
  // f(S), S in topological order: take the last reward v; if it has no requirements pay it; if requireAll add them
  // all to S; otherwise try each requirement. Memoised on S.
  const idx = new Map(topo.map((r, i) => [key(r), i]));
  const memo = new Map();
  const norm = (keys) => [...new Set(keys)].sort((a, b) => idx.get(a) - idx.get(b));
  function f(S) {
    if (!S.length) return { cost: 0, take: [] };
    const id = S.join(',');
    if (memo.has(id)) return memo.get(id);
    const v = byKey.get(S[S.length - 1]);
    const rest = S.slice(0, -1);
    const ps = reqs(v).map(key);
    const options = !ps.length ? [rest] : v.requireAll ? [norm([...rest, ...ps])] : ps.map((p) => norm([...rest, p]));
    let best = { cost: Infinity, take: [] };
    for (const next of options) {
      const sub = f(next);
      if (sub.cost + (v.cost || 0) < best.cost) best = { cost: sub.cost + (v.cost || 0), take: [key(v), ...sub.take] };
    }
    memo.set(id, best);
    return best;
  }
  const solo = new Map(R.map((r) => [key(r), f([key(r)]).cost]).filter(([, c]) => c < Infinity)); // per-reward cost
  const targets = (ui.calendar.picks || []).map((k) => byKey.get(k)).filter(Boolean);
  const plan = targets.length ? f(norm(targets.map(key))) : null;
  const chosen = plan && plan.cost < Infinity ? { claimed: new Set(plan.take), cost: plan.cost } : null;
  const path = chosen ? topo.filter((r) => chosen.claimed.has(key(r))) : [];
  const onPath = chosen ? chosen.claimed : new Set();
  const isTarget = new Set(targets.map(key));
  const lines = R.flatMap((b) => reqs(b)
    .map((a) => `<line class="${onPath.has(key(a)) && onPath.has(key(b)) ? 'on' : ''}${b.requireAll ? ' all' : ''}" x1="${a.col}" y1="${a.row + 0.5}" x2="${b.col}" y2="${b.row + 0.5}"/>`)).join('');
  const total = R.reduce((s, r) => s + (r.cost || 0), 0);
  const pathCost = chosen ? chosen.cost : 0;
  const have = ticketBalance(ev);
  // Owned cosmetics are replaced by r.fallback, as in the game. Avatars are checked against the save; skins are not
  // in the save, so their replacement is only noted.
  const owned = (r) => r.kind === 'avatar' && !!r.cosmetic && (state?.ownedAvatars || []).includes(r.cosmetic);
  const fbText = (fb) => `${fb.amount ? `${fmt(fb.coins ? coinAmount({ ...fb, amount: fb.amount }) : fb.amount)} ` : ''}${fb.label}`;
  const shown = (r) => (owned(r) && r.fallback
    ? { ...r, label: r.fallback.label, amount: r.fallback.amount, coins: r.fallback.coins, icon: r.fallback.icon, kind: 'currency', mini: null, swappedFrom: r.label }
    : r);
  const swapNote = (r) => (!r.fallback ? ''
    : owned(r) ? ` · you own ${r.label}, so you get ${fbText(r.fallback)} instead`
      : r.kind === 'skin' ? ` · if you already own this skin you get ${fbText(r.fallback)} instead (owned skins aren't in the save)`
        : ` · you'd get ${fbText(r.fallback)} instead if you owned it`);
  const amountText = (r) => (r.mini || r.kind === 'mini' ? `x${r.amount || 1}` : r.amount ? `+${fmt(coinAmount(r))}` : r.choices ? `Pick 1 of ${r.choices}` : r.kind === 'tome' ? 'x1' : esc(r.label));
  const node = (r0) => {
    const r = shown(r0);
    const tag = r.swappedFrom ? '<span class="tree-tag owned" title="You own this, so you get its replacement">Owned</span>'
      : r0.fallback && r0.kind === 'skin' ? '<span class="tree-tag maybe" title="Owned skins aren\'t in the save: if you have it, you get its replacement">?</span>' : '';
    return `<div class="tree-node${r0.kind === 'avatar' || r0.kind === 'skin' ? ' cosmetic' : ''}${onPath.has(key(r0)) ? ' on-path' : ''}${isTarget.has(key(r0)) ? ' target' : ''}" data-tree-pick="${key(r0)}" role="button" tabindex="0" aria-pressed="${isTarget.has(key(r0))}" style="left:${(r0.col / N) * 100}%;top:${r0.row * 118}px" title="${esc(r0.label)}${esc(swapNote(r0))}${r0.requireAll ? ' · needs all linked rewards above' : ''}${solo.has(key(r0)) ? ` · cheapest path ${fmt(solo.get(key(r0)))} tickets` : ''}">
      <div class="tree-ico">${rewardImg(r, ev)}${tag}</div>
      <div class="tree-amt">${amountText(r)}</div>
      ${r0.cost != null ? `<div class="tree-cost">${fmt(r0.cost)}<img src="${eventIcon(ev)}" alt=""></div>` : ''}
    </div>`;
  };
  return `<section class="panel cal-tree" id="calTree" style="--ev:var(--ev-${esc(ev.family)}, var(--ev-default))">
    <div class="cal-head"><img class="tree-head-ico" src="${eventIcon(ev)}" alt=""><h2>${esc(ev.name || ev.id)} rewards</h2>
      <button class="chip" data-cal-tree="" style="margin-left:auto">Close</button></div>
    <div class="tree-totals">
      <span><small>Collectable tickets</small><b>${ev.challengeTickets != null ? fmt(ev.challengeTickets) : '–'}</b></span>
      <span><small>Total rewards cost</small><b>${fmt(total)}</b></span>
      <span><small>Rewards</small><b>${R.length}</b></span>
      ${ev.challengeTickets != null ? `<span class="${ev.challengeTickets >= total ? 'cost-ok' : 'cost-no'}"><small>${ev.challengeTickets >= total ? 'Enough for everything' : 'Short of everything by'}</small><b>${ev.challengeTickets >= total ? '✓' : fmt(total - ev.challengeTickets)}</b></span>` : ''}
    </div>
    <p class="muted small">Collectable = every challenge, random dailies and weeklies at their usual count${ev.family === 'darkmoon' ? ', plus tickets from guild mates' : ''}.
      ${bonus ? `Coins include your +${bonus}% Booster bonus.` : 'Coins without the Booster (+50%).'}
      Click a reward for the cheapest path; Ctrl+click to add more.</p>
    ${renderChallenges(ev)}
    ${chosen ? `<div class="tree-path">
      <div><b>${targets.length === 1 ? `Cheapest path to ${esc(targets[0].label)}` : `Cheapest way to get all ${targets.length} picks`}: ${fmt(pathCost)} tickets</b>
        <span class="muted">· ${path.length} reward${path.length === 1 ? '' : 's'} to claim${have != null ? ` · you have ${fmt(have)} (${have >= pathCost ? 'enough' : `${fmt(pathCost - have)} short`})` : ''}${ev.challengeTickets != null ? ` · ${pathCost <= ev.challengeTickets ? 'fits within' : 'more than'} the ${fmt(ev.challengeTickets)} collectable` : ''}${(() => { const d = dailiesLeft(ev, Date.now()); return d ? ` · daily challenges still pay about ${fmt(d.tickets)} (${d.days} day${d.days === 1 ? '' : 's'} left)` : ''; })()}</span>
        <button class="chip small-chip" data-tree-pick="" style="margin-left:8px">Clear</button>
        ${(() => {
          // reward goal: notify when the ticket balance reaches the plan's cost
          const goal = state?.plans?.[ev.id];
          const label = targets.length === 1 ? targets[0].label : `${targets.length} rewards`;
          return goal && goal.cost === pathCost
            ? `<button class="chip small-chip tree-goal" data-tree-goal="clear" title="You'll get a notification when you have ${fmt(goal.cost)} tickets">🔔 Goal set · remove</button>`
            : `<button class="chip small-chip tree-goal" data-tree-goal="set" data-cost="${pathCost}" data-label="${esc(label)}" title="Get a notification when you have ${fmt(pathCost)} tickets">🔔 Notify me when I have enough tickets</button>`;
        })()}</div>
      <ol>${path.map((r0) => { const r = shown(r0); return `<li class="${isTarget.has(key(r0)) ? 'pick' : ''}">${rewardImg(r, ev)}<span>${esc(r.label)}${r.amount && !r.mini ? ` +${fmt(coinAmount(r))}` : r.mini ? ` x${r.amount || 1}` : ''}${r.swappedFrom ? ` <small class="muted">(owned ${esc(r.swappedFrom)})</small>` : ''}</span><b>${fmt(r0.cost || 0)}</b></li>`; }).join('')}</ol>
    </div>` : ''}
    <div class="tree-wrap${chosen ? ' picking' : ''}" style="--cols:${N};--rows:${rows}">
      <svg class="tree-lines" viewBox="0 0 ${N} ${rows}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
      <div class="tree-grid">${R.map(node).join('')}</div>
    </div>
  </section>`;
}

// ---- rendering ------------------------------------------------------------------------------------
function eventCard(r, now) {
  const { ev } = r;
  const running = r.start <= now && now < r.end;
  const live = (running || r.unknown) && isLive(ev); // the save lists only current events
  const tickets = running ? ticketBalance(ev) : null;
  const status = r.unknown
    ? 'Running now'
    : running ? `Ends in ${span(r.end - now)}` : `Starts in ${span(r.start - now)}`;
  return `<article class="cal-card" style="--ev:var(--ev-${esc(ev.family)}, var(--ev-default))">
    <img src="${eventIcon(ev)}" alt="">
    <div class="cal-name">${esc(ev.name || ev.id)}</div>
    <div class="cal-when">${status}</div>
    <div class="cal-dates">${r.unknown ? 'Dates not in the game files' : `${when(r.start)} – ${when(r.end)}`}</div>
    ${live || tickets != null || ev.rewards ? `<div class="cal-badges">
      ${live ? '<span class="cal-badge" title="Your game lists this event as running">Running in your game</span>' : ''}
      ${tickets != null ? `<span class="cal-badge tickets" title="As last saved by the game">${fmt(tickets)} tickets</span>` : ''}
      ${ev.rewards ? `<button class="cal-badge tree-btn" data-cal-tree="${esc(ev.id)}" aria-pressed="${ui.calendar.tree === ev.id}">Rewards</button>` : ''}
    </div>` : ''}
  </article>`;
}

/** The timeline's date range, e.g. "Nov 2 – Dec 6, 2026". */
function timelineRange(now) {
  const t = new Date(now);
  const a = new Date(t.getFullYear(), t.getMonth(), t.getDate() - Math.floor(TIMELINE_DAYS / 2) + (ui.calendar.offset || 0));
  const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + TIMELINE_DAYS - 1);
  return `${a.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Timeline section: header, slider and bars. */
function renderCalendarTimeline(now) {
  const off = ui.calendar.offset || 0;
  return `<section class="panel cal-timeline">
    <div class="cal-head">
      <h2 id="calRange">${esc(timelineRange(now))}</h2>
      <button class="chip" data-cal-nav="0" title="Back to today in the middle" ${off ? '' : 'disabled'}>Today</button>
      <span class="muted small">Wednesdays are highlighted: most events start and end on a Wednesday.</span>
    </div>
    <div class="cal-slide-row">
      <span class="muted small">Earlier · later</span>
      <input type="range" class="cal-slider keep" data-cal-slider min="${-TIMELINE_RANGE}" max="${TIMELINE_RANGE}" step="1" value="${off}" list="calTicks" aria-label="Move the timeline (days from today)">
      <datalist id="calTicks"><option value="0"></option></datalist>
    </div>
    <div class="cal-body">${renderTimelineBody(now)}</div>
  </section>`;
}

/** Full and short bar labels; CSS container queries show the one that fits. */
const barLabel = (full, short) => `<span class="lb lb-full">${full}</span><span class="lb lb-short">${short}</span>`;

function renderTimelineBody(now) {
  // TIMELINE_DAYS centred on today, shifted by the slider
  const n = TIMELINE_DAYS;
  const today = new Date(now);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.floor(n / 2) + (ui.calendar.offset || 0));
  const dayAt = (i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
  const from = base.getTime();
  const to = dayAt(n).getTime();
  const pct = (t) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;
  const runs = runsBetween(from, to);
  // one row per event name, in alphabetical order so rows keep their place while the slider moves
  const byName = new Map();
  for (const r of runs.sort((a, b) => a.start - b.start)) {
    const key = r.ev.name || r.ev.id;
    if (!byName.has(key)) byName.set(key, { ev: r.ev, runs: [] });
    byName.get(key).runs.push(r);
  }
  const rows = new Map([...byName].sort(([a], [b]) => a.localeCompare(b)));
  const todayIn = now >= from && now < to;
  const dates = Array.from({ length: n }, (_, i) => dayAt(i));
  const isToday = (d) => d.toDateString() === today.toDateString();
  const days = dates.map((d, i) => {
    const cls = [d.getDay() === 3 ? 'wed' : '', isToday(d) ? 'today' : '', i > 0 && d.getDate() === 1 ? 'm1' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" title="${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}">${d.getDate()}</span>`;
  }).join('');
  // month labels spanning their days
  const months = [];
  dates.forEach((d, i) => {
    const last = months[months.length - 1];
    if (last && last.m === d.getMonth()) last.span++;
    else months.push({ m: d.getMonth(), y: d.getFullYear(), start: i + 1, span: 1 });
  });
  const monthRow = months.map((x) => `<span class="${x.start > 1 ? 'm1' : ''}" style="grid-column:${x.start} / span ${x.span}" title="${MONTH_NAMES[x.m]} ${x.y}">${x.span >= 6 ? `${MONTH_NAMES[x.m]} ${x.y}` : MONTH_NAMES[x.m].slice(0, 3)}</span>`).join('');
  const nowLine = todayIn ? `<span class="cal-now" style="left:${pct(now)}%"></span>` : '';
  const bar = (r) => {
    const left = pct(r.start), width = Math.max(pct(r.end) - left, 0.8);
    const cls = ['cal-bar', r.end <= now ? 'past' : '', r.start < from ? 'cut-l' : '', r.end > to ? 'cut-r' : '', r.start <= now && now < r.end && isLive(r.ev) ? 'live' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" style="left:${left}%;width:${width}%" title="${esc(r.ev.name || r.ev.id)}: ${esc(when(r.start))} – ${esc(when(r.end))}">${barLabel(`${esc(dayOnly(r.start))} – ${esc(dayOnly(r.end))}`, `${new Date(r.start).getDate()} – ${new Date(r.end).getDate()}`)}</span>`;
  };
  // rotation rows
  const rotRows = (EVENTS.rotations || []).map((rot) => {
    const segs = [];
    for (let s = rotationAt(rot, from); s.start < to; s = rotationAt(rot, s.end)) segs.push(s);
    const bars = segs.map((s) => {
      const left = pct(s.start), width = pct(s.end) - left;
      const ico = rotIcon(rot, s.item);
      const cls = ['cal-bar', 'rot', ico ? 'has-ico' : '', s.end <= now ? 'past' : '', s.start < from ? 'cut-l' : '', s.end > to ? 'cut-r' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" style="left:${left}%;width:${width}%;--ev:${rotColor(rot, s.item)}" title="${esc(rotName(s.item))}: ${esc(when(s.start))} – ${esc(when(s.end))}">${ico}<span class="lb lb-name">${esc(rotName(s.item))}</span></span>`;
    }).join('');
    return `<div class="cal-row-label rot-row"><span>${esc(rot.label)}</span></div><div class="cal-track">${bars}${nowLine}</div>`;
  }).join('');
  return `${rows.size ? `<div class="cal-grid" style="--n:${n}">
      <span></span><div class="cal-months">${monthRow}</div>
      <span></span><div class="cal-days">${days}</div>
      ${[...rows.values()].map((row) => `
        <div class="cal-row-label"><img src="${eventIcon(row.ev)}" alt=""><span>${esc(row.ev.name || row.ev.id)}</span></div>
        <div class="cal-track" style="--ev:var(--ev-${esc(row.ev.family)}, var(--ev-default))">${row.runs.map(bar).join('')}${nowLine}</div>`).join('')}
      ${rotRows}
    </div>` : '<p class="muted">No events in the game files for these days.</p>'}`;
}

function renderCalendarRules() {
  // one line per event name (some events have one definition per month)
  const groups = new Map();
  for (const ev of EVENTS.events) {
    if (ev.schedule.kind === 'once') continue;
    const key = ev.name || ev.id;
    if (!groups.has(key)) groups.set(key, { ev, items: [] });
    groups.get(key).items.push(ev.schedule);
  }
  const line = ({ ev, items }) => {
    let text;
    if (items.length > 1 && items.every((s) => s.kind === 'dayOfMonth' && s.day === items[0].day && s.days === items[0].days)) {
      const months = items.map((s) => s.month).sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1].slice(0, 3));
      text = `${ordinal(items[0].day)} of the month · ${items[0].days} days <span class="muted">(${months.length === 12 ? 'every month' : months.join(', ')})</span>`;
    } else {
      text = items.map(ruleText).map(esc).join('<br>');
    }
    return `<li><img src="${eventIcon(ev)}" alt=""><b>${esc(ev.name || ev.id)}</b><span>${text}</span></li>`;
  };
  const hour = new Date(Date.UTC(2026, 0, 1, 18)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `<section class="panel cal-rules">
    <h2>How events repeat</h2>
    <p class="muted small">Events switch at 18:00 UTC (${esc(hour)} your time). A patch can change this;
      "Running in your game" always matches your game.</p>
    <ul>${[...groups.values()].sort((a, b) => (a.ev.name || '').localeCompare(b.ev.name || '')).map(line).join('')}</ul>
  </section>`;
}

async function renderCalendar() {
  const page = $('#tab-calendar');
  if (!page) return;
  try { await loadEvents(); await loadStore(); } catch {
    page.innerHTML = '<div class="panel muted">Could not load the event schedule (static/events.json).</div>';
    return;
  }
  if (ui.tab !== 'calendar') return;
  const now = Date.now();
  const soon = runsBetween(now - 60 * DAY, now + 60 * DAY);
  const running = soon.filter((r) => r.start <= now && now < r.end).sort((a, b) => a.end - b.end);
  // running events not covered by the schedule rules
  for (const id of state?.activeEvents || []) {
    if (running.some((r) => r.ev.saveId === id)) continue;
    const ev = EVENTS.events.find((e) => e.saveId === id);
    if (ev) running.push({ ev, start: now, end: now, unknown: true });
  }
  const upcoming = soon.filter((r) => r.start > now).sort((a, b) => a.start - b.start).slice(0, 8);

  const treeEv = ui.calendar.tree && EVENTS.events.find((e) => e.id === ui.calendar.tree);
  const scrollY = window.scrollY; // keep the scroll position on periodic re-renders
  page.innerHTML = `
    ${renderTickets(now)}
    <section class="panel">
      <div class="cal-head"><h2>Running now</h2>
        ${state?.activeEventsAt ? `<span class="muted small">Your game last reported its events ${esc(ago(state.activeEventsAt))}</span>` : ''}</div>
      ${running.length ? `<div class="cal-cards">${running.map((r) => eventCard(r, now)).join('')}</div>` : '<p class="muted">No events running.</p>'}
    </section>
    ${treeEv ? renderRewardTree(treeEv) : ''}
    ${renderShopOffers(now)}
    ${renderRotations(now)}
    <section class="panel">
      <div class="cal-head"><h2>Coming up</h2><span class="muted small">Next 60 days</span></div>
      ${upcoming.length ? `<div class="cal-cards">${upcoming.map((r) => eventCard(r, now)).join('')}</div>` : '<p class="muted">Nothing scheduled in the next 60 days.</p>'}
    </section>
    ${renderCalendarTimeline(now)}
    ${renderCalendarRules()}`;
  window.scrollTo(0, scrollY);
}

function bindCalendar() {
  const page = $('#tab-calendar');
  // click selects one reward (again to clear); Ctrl/Cmd+click toggles it in the plan
  const pick = (el, multi) => {
    const k = el.dataset.treePick;
    const picks = ui.calendar.picks || [];
    if (!k) ui.calendar.picks = [];
    else if (multi) ui.calendar.picks = picks.includes(k) ? picks.filter((x) => x !== k) : [...picks, k];
    else ui.calendar.picks = picks.length === 1 && picks[0] === k ? [] : [k];
    renderCalendar();
  };
  page.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.tree-node[data-tree-pick]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(el, e.ctrlKey || e.metaKey); }
  });
  page.addEventListener('click', async (e) => {
    const goalEl = e.target.closest('[data-tree-goal]');
    if (goalEl) {
      const set = goalEl.dataset.treeGoal === 'set';
      try {
        await post('/api/plans', { account: state.account, eventId: ui.calendar.tree, plan: set ? { cost: Number(goalEl.dataset.cost), label: goalEl.dataset.label } : null });
        state.plans = { ...(state.plans || {}) };
        if (set) state.plans[ui.calendar.tree] = { cost: Number(goalEl.dataset.cost), label: goalEl.dataset.label };
        else delete state.plans[ui.calendar.tree];
        renderCalendar();
      } catch (err) { goalEl.textContent = `Not saved: ${err.message}`; }
      return;
    }
    const pickEl = e.target.closest('[data-tree-pick]');
    if (pickEl) return pick(pickEl, e.ctrlKey || e.metaKey);
    const treeBtn = e.target.closest('[data-cal-tree]');
    if (treeBtn) {
      const id = treeBtn.dataset.calTree;
      ui.calendar.tree = id && ui.calendar.tree !== id ? id : null;
      ui.calendar.picks = [];
      await renderCalendar();
      if (ui.calendar.tree) $('#calTree')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const nav = e.target.closest('[data-cal-nav]');
    if (!nav) return;
    const step = Number(nav.dataset.calNav);
    if (step === 0) ui.calendar.offset = 0;
    renderCalendar();
  });
  page.addEventListener('input', (e) => {
    if (!e.target.matches('[data-cal-slider]')) return;
    ui.calendar.offset = Number(e.target.value);
    const now = Date.now();
    $('.cal-timeline .cal-body').innerHTML = renderTimelineBody(now);
    $('#calRange').textContent = timelineRange(now);
    $('.cal-timeline [data-cal-nav="0"]').disabled = !ui.calendar.offset;
  });
  // remember whether the challenge list is open across re-renders
  page.addEventListener('toggle', (e) => { if (e.target.classList?.contains('tree-challenges')) ui.calendar.chOpen = e.target.open; }, true);
  // refresh countdowns, except while the slider is in use
  setInterval(() => { if (ui.tab === 'calendar' && !document.hidden && !document.activeElement?.matches('[data-cal-slider]')) renderCalendar(); }, 30000);
}
