'use strict';
// Progress tab: daily income from lifetime totals, level growth, and a projection of when every owned mini reaches
// legendary. History comes from the server (data/progress.json). Depends on globals from app.js.

const PDAY = 86400000;
const MIN_SPAN = 12 * 3600000; // minimum history for rates

/** History points for the account, oldest first. */
function progressPoints() {
  const p = state?.progress;
  if (!p) return [];
  const pts = [p.first, ...p.days].filter(Boolean).sort((a, b) => a.t - b.t);
  return pts.filter((x, i) => i === 0 || x.t !== pts[i - 1].t);
}
const lifetimeOf = (pt, role) => pt.cur?.[RULES.currencyIds[role]]?.[1] ?? null;

/** Per-day rate over the last `days` days (null with too little history). */
function rateOf(get, days = 7) {
  const pts = progressPoints();
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const first = pts.find((x) => x.t >= last.t - days * PDAY) || pts[0];
  const span = last.t - first.t;
  const a = get(first), b = get(last);
  if (span < MIN_SPAN || a == null || b == null) return null;
  return ((b - a) / span) * PDAY;
}

/** Day-to-day changes: [{ day, value }]. */
function dailyDeltas(get) {
  const days = state?.progress?.days || [];
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const a = get(days[i - 1]), b = get(days[i]);
    if (a != null && b != null) out.push({ day: days[i].day, value: b - a });
  }
  return out.slice(-30);
}

// ---- charts (SVG, one series each) ----
function barChart(data, color, unit) {
  if (data.length < 2) return '<p class="muted small">Needs at least two days of history.</p>';
  const W = 560, H = 160, pad = 28, bw = Math.max(4, (W - pad) / data.length - 3);
  const max = Math.max(1, ...data.map((d) => d.value));
  const bars = data.map((d, i) => {
    const h = Math.max(1, (d.value / max) * (H - 24));
    const x = pad + i * ((W - pad) / data.length);
    return `<g class="pg-bar"><rect x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="3" fill="${color}"/>
      <rect class="hit" x="${x - 1}" y="0" width="${bw + 2}" height="${H}" fill="transparent"><title>${esc(d.day)}: ${fmt(Math.round(d.value))} ${unit}</title></rect></g>`;
  }).join('');
  return `<svg class="pg-chart" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="${esc(unit)} per day">
    <line x1="${pad}" y1="${H}" x2="${W}" y2="${H}" class="axis"/>
    <text x="${pad - 4}" y="12" class="tick" text-anchor="end">${fmt(Math.round(max))}</text>
    <text x="${pad - 4}" y="${H}" class="tick" text-anchor="end">0</text>
    ${bars}
    <text x="${pad}" y="${H + 14}" class="tick">${esc(data[0].day.slice(5))}</text>
    <text x="${W}" y="${H + 14}" class="tick" text-anchor="end">${esc(data[data.length - 1].day.slice(5))}</text>
  </svg>`;
}
function lineChart(data, color, unit) {
  if (data.length < 2) return '<p class="muted small">Needs at least two days of history.</p>';
  const W = 560, H = 160, pad = 36;
  const vals = data.map((d) => d.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), range = Math.max(1, hi - lo);
  const x = (i) => pad + (i / (data.length - 1)) * (W - pad - 6);
  const y = (v) => 8 + (1 - (v - lo) / range) * (H - 16);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  return `<svg class="pg-chart" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="${esc(unit)} over time">
    <line x1="${pad}" y1="${H}" x2="${W}" y2="${H}" class="axis"/>
    <text x="${pad - 4}" y="12" class="tick" text-anchor="end">${fmt(hi)}</text>
    <text x="${pad - 4}" y="${H}" class="tick" text-anchor="end">${fmt(lo)}</text>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.value)}" r="4" fill="${color}" stroke="var(--panel)" stroke-width="2"><title>${esc(d.day)}: ${fmt(d.value)} ${unit}</title></circle>`).join('')}
    <text x="${pad}" y="${H + 14}" class="tick">${esc(data[0].day.slice(5))}</text>
    <text x="${W}" y="${H + 14}" class="tick" text-anchor="end">${esc(data[data.length - 1].day.slice(5))}</text>
  </svg>`;
}

// ---- projections ----------------------------------------------------------------------------------
function legendaryProjection() {
  const need = { arcEnergy: 0, stars: 0, cores: {} };
  for (const u of state.units) {
    if (u.synthetic) continue;
    const r = remainingToLegendary(u);
    need.arcEnergy += r.arcEnergy; need.stars += r.stars;
    for (const [k, v] of Object.entries(r.cores)) need.cores[k] = (need.cores[k] || 0) + v;
  }
  const rows = [];
  const add = (label, remaining, rate, unit) => {
    const left = Math.max(0, remaining);
    const days = left === 0 ? 0 : rate > 0 ? left / rate : Infinity;
    rows.push({ label, left, rate, days, unit });
  };
  add(curName('arcEnergy'), need.arcEnergy - balance('arcEnergy'), rateOf((p) => lifetimeOf(p, 'arcEnergy')), '');
  add('Stars', need.stars, rateOf((p) => p.stars), '');
  for (const [role, n] of Object.entries(need.cores)) add(curName(role), n - balance(role), rateOf((p) => lifetimeOf(p, role)), '');
  return rows;
}
const whenText = (days) => (days === 0 ? 'done' : !isFinite(days) ? 'no income yet' : days > 3650 ? '10+ years'
  : new Date(Date.now() + days * PDAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));

function renderProgress() {
  const page = $('#tab-progress');
  if (!page || !state) return;
  const pts = progressPoints();
  const since = pts[0] ? new Date(pts[0].t) : null;
  const enough = pts.length >= 2 && pts[pts.length - 1].t - pts[0].t >= MIN_SPAN;
  const tile = (label, v, sub) => `<div class="stat-card"><div class="k">${esc(label)}</div><div class="v">${v == null ? '–' : esc(v)}</div><div class="small">${esc(sub)}</div></div>`;
  const perDay = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${fmt(Math.round(v))}`);
  const proj = legendaryProjection();
  const slowest = proj.filter((r) => r.left > 0).sort((a, b) => b.days - a.days)[0];
  const levelsWeek = rateOf((p) => p.lv);
  page.innerHTML = `
    <section class="panel pg-head">
      <h2>Progress &amp; projections</h2>
      <span class="muted small">${since ? `History since ${esc(since.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}, from the game's lifetime totals: days without the tracker count too.` : 'History starts with the next scan.'}
        ${enough ? '' : ' Rates appear after 12 hours, charts after two days.'}</span>
    </section>
    <div class="summary">
      ${tile(`${curName('coins')} per day`, perDay(rateOf((p) => lifetimeOf(p, 'coins'))), 'earned, last 7 days')}
      ${tile(`${curName('arcEnergy')} per day`, perDay(rateOf((p) => lifetimeOf(p, 'arcEnergy'))), 'earned, last 7 days')}
      ${tile('Stars per day', perDay(rateOf((p) => p.stars)), 'put into minis, last 7 days')}
      ${tile('Levels per week', levelsWeek == null ? null : `+${(levelsWeek * 7).toFixed(1)}`, 'all minis together')}
    </div>
    <section class="panel">
      <h2>All minis legendary</h2>
      ${slowest ? `<p class="pg-hero">${!enough ? '<b>Not enough history yet</b> for a date'
        : isFinite(slowest.days) ? `About <b>${esc(whenText(slowest.days))}</b> at the current pace`
          : `<b>No date yet:</b> no ${esc(slowest.label)} earned in the last 7 days`}
        <span class="muted small">· slowest: ${esc(slowest.label)}</span></p>` : '<p class="pg-hero"><b>Done:</b> every owned mini is legendary.</p>'}
      <table class="pg-table"><thead><tr><th>Still needed</th><th>Amount</th><th>Income per day</th><th>Done by</th></tr></thead><tbody>
        ${proj.map((r) => `<tr${r === slowest ? ' class="slowest"' : ''}><td>${esc(r.label)}</td><td>${fmt(Math.round(r.left))}</td><td>${r.rate == null ? '–' : fmt(Math.round(r.rate))}</td><td>${enough || r.left === 0 ? esc(whenText(r.days)) : '–'}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Owned minis only: what's still needed for legendary, minus what you have, divided by your income over the
        last 7 days. Cores bought with coins aren't counted.</p>
    </section>
    <div class="pg-charts">
      <section class="panel"><h2>${esc(curName('coins'))} earned per day</h2>${barChart(dailyDeltas((p) => lifetimeOf(p, 'coins')), 'var(--gold-2)', curName('coins'))}</section>
      <section class="panel"><h2>${esc(curName('arcEnergy'))} earned per day</h2>${barChart(dailyDeltas((p) => lifetimeOf(p, 'arcEnergy')), 'var(--gem-1)', curName('arcEnergy'))}</section>
      <section class="panel"><h2>Total level, all minis</h2>${lineChart((state.progress?.days || []).slice(-60).map((d) => ({ day: d.day, value: d.lv })), 'var(--good)', 'levels')}</section>
    </div>`;
}
