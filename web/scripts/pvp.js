'use strict';
// PvP tab: season, rank, Victory Road, season-end rewards, the modifier rotation (gamedata/pvp.json) and the wins and
// losses the server inferred from honor and Victory Point changes. Depends on globals from app.js and calendar.js.

let PVP = null;
async function loadPvp() {
  if (PVP) return PVP;
  const r = await fetch('/static/pvp.json');
  if (!r.ok) throw new Error('no pvp.json');
  PVP = await r.json();
  return PVP;
}

const pvpSeasonAt = (t) => PVP.seasons.find((s) => Date.parse(s.start) <= t && t < Date.parse(s.end)) || null;
const pvpRankOf = (honor) => PVP.ranks.reduce((r, x) => (honor >= x.from ? x : r), PVP.ranks[0]);
const pvpNextRank = (rank) => PVP.ranks[PVP.ranks.indexOf(rank) + 1] || null;
const pvpFrame = (rank) => (rank?.frame ? `/static/pvp/${encodeURIComponent(rank.frame)}.webp` : '');

/** The modifier set in play at time t: { mods: [id], start, end } (each season runs its own rotation). */
function pvpSetAt(t) {
  const rot = pvpSeasonAt(t)?.rotation;
  if (!rot?.sets.length) return null;
  const p = rot.periodDays * DAY, t0 = Date.parse(rot.start);
  const k = Math.floor((t - t0) / p);
  const n = rot.sets.length;
  return { mods: rot.sets[((k % n) + n) % n], start: t0 + k * p, end: t0 + (k + 1) * p };
}

function pvpReward(r) {
  const amount = r.amount != null && r.amount !== 1 ? `${fmt(r.amount)}× ` : r.amount === 1 && r.kind === 'currency' ? '1× ' : '';
  const icon = r.icon ? `<img src="/static/rewards/${encodeURIComponent(r.icon)}.webp" alt="">` : '';
  const options = r.options ? ` <small class="muted">(pick from ${r.options})</small>` : '';
  return `<span class="pvp-reward">${icon}<span>${esc(amount)}${esc(r.label)}${options}</span></span>`;
}

/** Wins and losses in log entries from time `from`; estimated if any entry was. */
function pvpRecord(log, from = 0) {
  let wins = 0, losses = 0, estimated = false, honorOnly = false;
  for (const e of log) {
    if (Date.parse(e.t) < from || !(e.wins || e.losses)) continue;
    wins += e.wins || 0;
    losses += e.losses || 0;
    if (e.estimated) estimated = true;
    if (e.honorOnly) honorOnly = true;
  }
  return { wins, losses, estimated, honorOnly };
}

/** Current streak from the newest readings: { kind: 'win'|'loss', n } or null. Mixed readings end it. */
function pvpStreak(log) {
  let kind = null, n = 0;
  for (const e of [...log].reverse()) {
    if (!(e.wins || e.losses)) continue;
    const k = e.wins && !e.losses ? 'win' : e.losses && !e.wins ? 'loss' : null;
    if (!k || (kind && k !== kind)) { if (!kind && !k) return null; break; }
    kind = k;
    n += e.wins || e.losses;
  }
  return kind ? { kind, n } : null;
}

function pvpHonorChart(log, season) {
  const pts = log.map((e) => ({ t: Date.parse(e.t), honor: e.honor, e }));
  if (pts.length < 2) return '<p class="muted small">The chart fills in as the tracker sees your honor change.</p>';
  const W = 1100, H = 170, pad = 44;
  const t0 = Math.min(Date.parse(season.start), pts[0].t), t1 = Math.max(Date.now(), pts[pts.length - 1].t);
  const lo = Math.min(...pts.map((p) => p.honor)), hi = Math.max(...pts.map((p) => p.honor));
  const range = Math.max(200, hi - lo), base = lo - range * 0.1, top = hi + range * 0.1;
  const x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad - 8);
  const y = (v) => 8 + (1 - (v - base) / (top - base)) * (H - 16);
  // rank floors inside the visible range
  const floors = PVP.ranks.filter((r) => r.from > base && r.from < top)
    .map((r) => `<line x1="${pad}" x2="${W}" y1="${y(r.from).toFixed(1)}" y2="${y(r.from).toFixed(1)}" class="floor"/><text x="${W - 4}" y="${(y(r.from) - 3).toFixed(1)}" class="tick" text-anchor="end">${esc(r.name)}</text>`).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.honor).toFixed(1)}`).join(' ');
  const dots = pts.filter((p) => p.e.wins || p.e.losses).map((p) => {
    const cls = p.e.wins && !p.e.losses ? 'win' : p.e.losses && !p.e.wins ? 'loss' : 'mixed';
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.honor).toFixed(1)}" r="3.5" class="${cls}"><title>${esc(when(p.t))}: ${fmt(p.honor)} honor (${pvpResult(p.e)})</title></circle>`;
  }).join('');
  return `<svg class="pg-chart pvp-chart" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="Honor this season">
    <line x1="${pad}" y1="${H}" x2="${W}" y2="${H}" class="axis"/>${floors}
    <text x="${pad - 4}" y="${(y(hi) + 4).toFixed(1)}" class="tick" text-anchor="end">${fmt(hi)}</text>
    <text x="${pad - 4}" y="${(y(lo) + 4).toFixed(1)}" class="tick" text-anchor="end">${fmt(lo)}</text>
    <path d="${path}" fill="none" stroke="var(--gold-1)" stroke-width="2" stroke-linejoin="round"/>${dots}
    <text x="${pad}" y="${H + 14}" class="tick">${esc(dayOnly(t0))}</text>
    <text x="${W}" y="${H + 14}" class="tick" text-anchor="end">${esc(dayOnly(t1))}</text>
  </svg>`;
}

function pvpResult(e) {
  const parts = [];
  if (e.wins) parts.push(e.wins === 1 ? 'win' : `${e.wins} wins`);
  if (e.losses) parts.push(e.losses === 1 ? 'loss' : `${e.losses} losses`);
  return parts.join(' + ') || 'no match';
}

async function renderPvp() {
  const page = $('#tab-pvp');
  if (!page) return;
  try { await loadPvp(); await loadEvents(); } catch {
    page.innerHTML = '<div class="panel muted">PvP data isn\'t in this game data yet: it comes with the next game-data update.</div>';
    return;
  }
  if (ui.tab !== 'pvp') return;
  const now = Date.now();
  const season = pvpSeasonAt(now);
  const mine = state?.pvp || null;
  const mySeason = mine && PVP.seasons.find((s) => s.saveId === mine.season);
  // the save keeps the last season until the account plays again: then honor and VP are from that season
  const stale = mine && season && mySeason && mySeason.id !== season.id;
  const log = state?.pvpLog || [];

  // ---- season and rank
  let rankCard;
  if (!mine) {
    rankCard = '<div class="pvp-card"><div class="rot-label">Rank</div><p class="muted">No PvP rank in this account\'s save yet. Play a PvP match and it shows up here.</p></div>';
  } else {
    const rank = pvpRankOf(mine.honor), next = pvpNextRank(rank);
    const pct = next ? Math.min(100, Math.max(0, ((mine.honor - rank.from) / (next.from - rank.from)) * 100)) : 100;
    rankCard = `<div class="pvp-card pvp-rank">
      <div class="pvp-frame">${rank.frame ? `<img src="${pvpFrame(rank)}" alt="">` : ''}<b>${fmt(mine.honor)}</b></div>
      <div class="pvp-rank-text">
        <div class="rot-label">Rank${stale ? ` · ${esc(mySeason.name)}` : ''}</div>
        <div class="pvp-big">${esc(rank.name)}</div>
        <div>${fmt(mine.honor)} honor</div>
        ${next ? `<div class="bar" title="${fmt(mine.honor - rank.from)} of ${fmt(next.from - rank.from)}"><span style="width:${pct.toFixed(1)}%"></span></div>
          <div class="small">${fmt(next.from - mine.honor)} to ${esc(next.name)}</div>` : '<div class="small">Top rank</div>'}
      </div>
    </div>`;
  }
  const seasonCard = season ? `<div class="pvp-card">
      <div class="rot-label">Season</div>
      <div class="pvp-big">${esc(season.name)}</div>
      <div class="cal-when">Ends in ${span(Date.parse(season.end) - now)}</div>
      <div class="small">${esc(dayOnly(season.start))} – ${esc(when(season.end))}</div>
      <div class="small">Maps: ${esc(season.maps.join(', '))}</div>
    </div>` : '';

  // ---- record
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const seasonRec = pvpRecord(log), todayRec = pvpRecord(log, midnight.getTime());
  const streak = pvpStreak(log);
  const unexplained = log.filter((e) => e.unexplained && !e.manual).length;
  const rate = seasonRec.wins + seasonRec.losses ? Math.round((seasonRec.wins / (seasonRec.wins + seasonRec.losses)) * 100) : null;
  const recordCard = `<div class="pvp-card">
      <div class="rot-label">Wins / losses${seasonRec.estimated ? ' <span class="flag warn" title="Some changes fit more than one combination of wins and losses: the tracker picked the likeliest">estimated</span>' : ''}</div>
      <div class="pvp-big"><span class="pvp-win">${fmt(seasonRec.wins)}</span> – <span class="pvp-loss">${fmt(seasonRec.losses)}</span>${rate != null ? ` <small class="muted">${rate}%</small>` : ''}</div>
      <div class="small">Today ${fmt(todayRec.wins)} – ${fmt(todayRec.losses)}${streak ? ` · ${streak.n} ${streak.kind === 'win' ? (streak.n === 1 ? 'win' : 'wins') : (streak.n === 1 ? 'loss' : 'losses')} in a row` : ''}</div>
      <div class="small">Counted from honor and Victory Point changes the tracker sees, so matches before it first saw this account aren't included.${seasonRec.honorOnly ? ' Victory Points stopped moving, so some results come from honor alone and losses at a rank floor may be missing.' : ''}</div>
      ${unexplained ? `<div class="small"><span class="flag warn">${unexplained} unexplained</span> change${unexplained > 1 ? 's' : ''} below: mark ${unexplained > 1 ? 'them' : 'it'} as a win or a loss.</div>` : ''}
    </div>`;

  // ---- Victory Road
  let roadCard = '';
  if (season) {
    const vp = mine && !stale ? mine.vp : 0;
    const road = season.victoryRoad;
    const nextM = road.find((m) => m.vp > vp);
    const prevVp = [...road].reverse().find((m) => m.vp <= vp)?.vp ?? 0;
    const reached = road.filter((m) => m.vp <= vp).length;
    const pct = nextM ? Math.min(100, ((vp - prevVp) / (nextM.vp - prevVp)) * 100) : 100;
    roadCard = `<div class="pvp-card">
      <div class="rot-label">Victory Road</div>
      <div class="pvp-big">${fmt(vp)} <small class="muted">Victory Points</small></div>
      ${nextM ? `<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="small">${fmt(nextM.vp - vp)} to the next reward: ${pvpReward(nextM.reward)}</div>` : '<div class="small">Every reward reached.</div>'}
      <div class="small">${reached} of ${road.length} rewards reached. Claim them in the game before the season ends: Victory Road resets.</div>
    </div>`;
  }

  // ---- modifiers
  const cur = pvpSetAt(now);
  let rotation = '';
  if (cur) {
    const mod = (id, big) => {
      const m = PVP.modifiers[id] || { name: id };
      return `<div class="pvp-mod${big ? ' big' : ''}" title="${esc(m.description || '')}">${m.icon ? `<img src="/static/pvp/${encodeURIComponent(m.icon)}.webp" alt="">` : ''}<div><b>${esc(m.name)}</b>${big && m.description ? `<div class="small">${esc(m.description)}</div>` : ''}</div></div>`;
    };
    const upcoming = [];
    for (let t = cur.end, i = 0; i < 4; i++) { const s = pvpSetAt(t + 1); if (!s) break; upcoming.push(s); t = s.end; }
    rotation = `<section class="panel">
      <div class="cal-head"><h2>Modifiers</h2><span class="muted small">Change every ${PVP.seasons[0]?.rotation?.periodDays || 3} days · next in ${span(cur.end - now)}</span></div>
      <div class="pvp-mods">${cur.mods.map((id) => mod(id, true)).join('')}</div>
      ${upcoming.length ? `<div class="pvp-next">${upcoming.map((s) => `<div class="pvp-next-row"><span class="muted small">${esc(dayOnly(s.start))}</span>${s.mods.map((id) => mod(id, false)).join('')}</div>`).join('')}</div>` : ''}
    </section>`;
  }

  // ---- season-end rewards
  let endRewards = '';
  if (season) {
    const rank = mine && !stale ? pvpRankOf(mine.honor) : PVP.ranks[0];
    const rowFor = (r) => season.endRewards.find((e) => e.rank === r.id && !e.top);
    const lowest = PVP.ranks.find((r) => rowFor(r));
    const mineRow = rowFor(rank);
    const target = PVP.ranks.slice(PVP.ranks.indexOf(rank) + 1).find((r) => rowFor(r));
    const line = (label, row) => `<div class="pvp-end"><div class="pvp-end-label">${label}</div><div class="pvp-rewards">${row.rewards.map(pvpReward).join('')}</div></div>`;
    endRewards = `<section class="panel">
      <div class="cal-head"><h2>Season-end rewards</h2><span class="muted small">By your rank when ${esc(season.name)} ends (${esc(dayOnly(season.end))})</span></div>
      ${mineRow ? line(`At your rank: <b>${esc(rank.name)}</b>`, mineRow) : `<p class="small">No season-end rewards below ${esc(lowest?.name || 'Platinum Prodigy I')} (${fmt(lowest?.from ?? 9000)} honor).</p>`}
      ${target ? line(`At ${esc(target.name)}${mine && !stale ? ` <span class="muted">(${fmt(target.from - mine.honor)} more honor)</span>` : ''}`, rowFor(target)) : ''}
    </section>`;
  }

  // ---- honor chart and recent matches
  // every match this season, newest first; the list scrolls with 8 rows in view. Changes no win/loss combination
  // explains are listed too: the player can mark them as a win or a loss.
  const recent = log.filter((e) => e.wins || e.losses || e.unexplained).reverse();
  const resultCell = (e) => {
    if (e.unexplained && !e.manual) {
      return `<td><span class="flag warn" title="No combination of wins and losses gives this change">unexplained</span>
        <button class="chip" data-pvp-result="win" data-t="${esc(e.t)}">Win</button> <button class="chip" data-pvp-result="loss" data-t="${esc(e.t)}">Loss</button></td>`;
    }
    const cls = e.wins && !e.losses ? 'pvp-win' : e.losses && !e.wins ? 'pvp-loss' : '';
    const note = e.manual ? ` <span class="muted small" title="Set by you">(set by you)</span> <button class="chip" data-pvp-result="" data-t="${esc(e.t)}" title="Mark as unexplained again">Undo</button>`
      : e.estimated ? ' <span class="muted small" title="More than one combination fits this change">(est.)</span>' : '';
    return `<td class="${cls}">${esc(pvpResult(e))}${note}</td>`;
  };
  const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
  const history = mine && season && !stale ? `<section class="panel">
      <div class="cal-head"><h2>Honor this season</h2></div>
      ${pvpHonorChart(log, season)}
      ${recent.length ? `<div class="pvp-matches"><table class="pg-table"><thead><tr><th>When</th><th>Result</th><th>Honor</th><th>Victory Points</th></tr></thead><tbody>
        ${recent.map((e) => `<tr><td>${esc(ago(e.t))}</td>${resultCell(e)}
          <td>${signed(e.dh)} → ${fmt(e.honor)}</td><td>${signed(e.dv)} → ${fmt(e.vp)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small">No matches seen yet this season.</p>'}
    </section>` : '';

  // ---- full Victory Road
  const roadList = season ? `<section class="panel">
      <div class="cal-head"><h2>Victory Road</h2><span class="muted small">${esc(season.name)} · Victory Points from every finished match: ${fmt(PVP.victoryPoints.base * PVP.victoryPoints.loss)} for a loss, ${fmt(PVP.victoryPoints.base * PVP.victoryPoints.win)} for a win, more on a win streak</span></div>
      <div class="pvp-road">${season.victoryRoad.map((m) => {
        const got = mine && !stale && mine.vp >= m.vp;
        return `<div class="pvp-step${got ? ' got' : ''}"><span class="pvp-step-vp">${fmt(m.vp)}</span>${pvpReward(m.reward)}</div>`;
      }).join('')}</div>
    </section>` : '';

  page.innerHTML = `
    ${stale ? `<div class="panel small">This account's save still shows ${esc(mySeason.name)}: the game updates it at the next PvP match.</div>` : ''}
    <section class="pvp-cards">${rankCard}${recordCard}${roadCard}${seasonCard}</section>
    ${rotation}${history}${endRewards}${roadList}`;
}

function bindPvp() {
  // Win / Loss for an unexplained change; Undo ("") clears it
  $('#tab-pvp').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pvp-result]');
    if (!b || !state?.account) return;
    b.disabled = true;
    try { await post('/api/pvp/result', { account: state.account, t: b.dataset.t, result: b.dataset.pvpResult || null }); }
    catch (err) { alert(`Could not save: ${err.message}`); }
    poll();
  });
}
