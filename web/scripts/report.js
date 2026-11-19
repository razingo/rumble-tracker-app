'use strict';
// "Report a problem": forwards page script errors to the local server's error log, and builds a report (description
// and cleaned diagnostics) the user can open as a GitHub issue or copy. Nothing is sent without the user submitting it.
// Loaded first so it also catches start-up errors.

// ---- catching the page's errors --------------------------------------------------------------------------
(() => {
  let sent = 0;
  const report = (message, stack) => {
    if (++sent > 30) return; // cap error loops
    fetch('/api/client-error', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ where: location.hash.slice(1), message: String(message || '').slice(0, 500), stack: String(stack || '').slice(0, 1500) }),
    }).catch(() => { /* server not reachable: nothing to do */ });
  };
  // bubbling listener: script errors only, not failed image loads
  window.addEventListener('error', (e) => report(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason, e.reason?.stack));
})();

// ---- the dialog ----------------------------------------------------------------------------------------------
const REPORT = { data: null, title: '', what: '', steps: '', include: true };
const MAX_URL = 7500; // GitHub rejects longer URLs

function renderReportBadge() {
  const b = document.getElementById('reportBtn');
  if (!b) return;
  const n = state?.problems || 0;
  b.classList.toggle('has-problems', n > 0);
  b.title = n ? `${n} error${n > 1 ? 's' : ''} noted since the tracker started` : '';
}

function reportText() {
  const d = REPORT.data;
  const body = [
    '### What happened', REPORT.what.trim() || '_(not described)_', '',
    ...(REPORT.steps.trim() ? ['### How to make it happen', REPORT.steps.trim(), ''] : []),
    ...(REPORT.include && d ? ['### Details (added by the tracker)', '```', d.diagnostics, '```'] : []),
  ].join('\n');
  return { title: REPORT.title.trim() || 'Problem report', body };
}

/** GitHub new-issue URL, trimming the oldest errors to fit MAX_URL. */
function issueUrl() {
  const repo = REPORT.data?.repo;
  const make = (title, body) => `https://github.com/${repo}/issues/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let { title, body } = reportText();
  let url = make(title, body);
  while (url.length > MAX_URL) {
    const lines = body.split('\n');
    const firstError = lines.findIndex((l) => l.startsWith('- ['));
    if (firstError >= 0) { lines.splice(firstError, 1, ...(lines.includes('- (older errors left out)') ? [] : ['- (older errors left out)'])); body = lines.join('\n'); }
    else body = `${body.slice(0, Math.floor(body.length * 0.8))}\n…(shortened)`;
    url = make(title, body);
  }
  return url;
}

function renderReportDialog(msg = '') {
  const dlg = $('#reportDialog');
  const d = REPORT.data;
  dlg.innerHTML = `<form method="dialog" class="rp-form">
    <div class="nt-head"><h2>Report a problem</h2><button class="chip" value="close" aria-label="Close">✕</button></div>
    <p class="muted small">Opens a GitHub issue (free account needed). Nothing is sent until you press <b>Submit</b> there.</p>
    <label class="rp-field">Short title <input data-rp="title" maxlength="120" value="${esc(REPORT.title)}" placeholder="e.g. Calendar shows the wrong end date for Darkmoon Faire"></label>
    <label class="rp-field">What happened? What did you expect?
      <textarea data-rp="what" rows="4" placeholder="Please don't include account names or other personal details.">${esc(REPORT.what)}</textarea></label>
    <label class="rp-field">How can it be repeated? <span class="muted small">(optional)</span>
      <textarea data-rp="steps" rows="2">${esc(REPORT.steps)}</textarea></label>
    <label class="rp-include"><input type="checkbox" data-rp="include" ${REPORT.include ? 'checked' : ''}> Add the details below (helps a lot)</label>
    <details class="rp-details"${d?.errors ? ' open' : ''}><summary>Details that would be added${d ? ` · ${d.errors ? `${d.errors} recent error${d.errors > 1 ? 's' : ''}` : 'no errors noted'}` : ''}</summary>
      <pre>${d ? esc(d.diagnostics) : 'Loading…'}</pre>
      <p class="muted small">Versions, game-data status and recent errors, with names, account IDs and other personal details
        removed. Your collection is never included.</p>
    </details>
    <div class="rp-actions">
      <button type="button" class="btn" data-rp-open ${d ? '' : 'disabled'}>Open on GitHub</button>
      <button type="button" class="chip" data-rp-copy ${d ? '' : 'disabled'}>Copy report</button>
      ${d?.errors ? '<button type="button" class="chip" data-rp-clear title="Forget the errors noted so far">Clear errors</button>' : ''}
      <span class="nt-msg small">${esc(msg)}</span>
    </div>
  </form>`;
}

async function openReportDialog() {
  const dlg = $('#reportDialog');
  REPORT.data = null;
  renderReportDialog();
  dlg.showModal();
  try {
    REPORT.data = await fetch(`/api/report?page=${encodeURIComponent(ui.tab || '')}`).then((r) => r.json());
    renderReportDialog();
  } catch { renderReportDialog('The tracker server is not reachable.'); }
}

function bindReport() {
  const dlg = $('#reportDialog');
  $('#reportBtn').addEventListener('click', openReportDialog);
  dlg.addEventListener('input', (e) => {
    const k = e.target.dataset.rp;
    if (k) REPORT[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const msg = (t, ok) => { const m = dlg.querySelector('.nt-msg'); m.textContent = t; m.className = `nt-msg small ${ok ? 'cost-ok' : 'cost-no'}`; };
    if (e.target.closest('[data-rp-open]')) {
      if (!REPORT.what.trim()) { msg('Please describe what happened first.', false); dlg.querySelector('[data-rp="what"]').focus(); return; }
      openExternal(issueUrl());
      msg('Opened in your browser: check it and press Submit there.', true);
    } else if (e.target.closest('[data-rp-copy]')) {
      const { title, body } = reportText();
      try { await navigator.clipboard.writeText(`${title}\n\n${body}`); msg('Copied.', true); } catch { msg('Copying was blocked by the browser.', false); }
    } else if (e.target.closest('[data-rp-clear]')) {
      await post('/api/report/clear', {});
      REPORT.data = await fetch('/api/report').then((r) => r.json());
      if (state) state.problems = 0;
      renderReportBadge();
      renderReportDialog('Cleared.');
    }
  });
}
