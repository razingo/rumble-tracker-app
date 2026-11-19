'use strict';
// Notification settings dialog. Settings are stored and notifications sent by the server, also while the page is
// closed. Depends on globals from app.js.

let NOTIFY = null; // { settings, types, log, pending, playing }

async function loadNotify() {
  NOTIFY = await fetch('/api/notifications').then((r) => r.json());
}

function renderNotifyDialog() {
  const dlg = $('#alertsDialog');
  if (!NOTIFY) { dlg.innerHTML = '<p>Loading…</p>'; return; }
  const s = NOTIFY.settings;
  const accounts = state?.accounts || [];
  const row = (t) => {
    const v = s.types[t.id];
    return `<tr>
      <td><label class="nt-on"><input type="checkbox" data-nt-type="${t.id}" data-nt-field="on" ${v.on ? 'checked' : ''}> ${esc(t.label)}</label>
        ${t.hoursBefore ? `<span class="nt-hours">· warn <input type="number" min="1" max="72" value="${v.hoursBefore}" data-nt-type="${t.id}" data-nt-field="hoursBefore"> h before the end</span>` : ''}</td>
      <td class="nt-play"><input type="checkbox" data-nt-type="${t.id}" data-nt-field="whenPlaying" ${v.whenPlaying ? 'checked' : ''} ${v.on ? '' : 'disabled'} aria-label="Also while the game is running: ${esc(t.label)}"></td>
    </tr>`;
  };
  dlg.innerHTML = `<form method="dialog" class="nt-form">
    <div class="nt-head"><h2>Notifications</h2><button class="chip" value="close" aria-label="Close">✕</button></div>
    <p class="muted small">They keep coming while the tracker runs, even with this window closed.</p>
    <label class="nt-master"><input type="checkbox" data-nt-field="enabled" ${s.enabled ? 'checked' : ''}> Send notifications</label>
    <label class="nt-acc">For <select data-nt-field="account">
      <option value="">all accounts</option>
      ${accounts.map((a) => `<option value="${a.id}" ${s.account === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
    </select></label>
    <table class="nt-table${s.enabled ? '' : ' off'}">
      <thead><tr><th></th><th title="Unticked: not sent while the game is running">Also while<br>playing</th></tr></thead>
      <tbody>${NOTIFY.types.map(row).join('')}</tbody>
    </table>
    <p class="muted small">Unticked in "Also while playing": not sent while the game runs${NOTIFY.playing ? ' (it is running now)' : ''}.
      Set reward goals on an event's reward tree in the Calendar.</p>
    <div class="nt-quiet">
      <label><input type="checkbox" data-nt-field="quiet.on" ${s.quiet.on ? 'checked' : ''}> Quiet hours</label>
      <input type="time" data-nt-field="quiet.from" value="${esc(s.quiet.from)}"> – <input type="time" data-nt-field="quiet.to" value="${esc(s.quiet.to)}">
      <span class="muted small">held until they end${NOTIFY.pending ? ` · ${NOTIFY.pending} waiting` : ''}</span>
    </div>
    <div class="nt-actions"><button type="button" class="btn" data-nt-test>Send a test notification</button><span class="nt-msg small"></span></div>
    <h3>Recent</h3>
    ${NOTIFY.log.length ? `<ul class="nt-log">${NOTIFY.log.map((n) => `<li><span class="muted small">${esc(new Date(n.t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span> <b>${esc(n.title)}</b> <span class="small">${esc(n.body)}</span>${n.delivered ? '' : ' <span class="cost-no small">(not delivered)</span>'}</li>`).join('')}</ul>` : '<p class="muted small">Nothing sent yet.</p>'}
  </form>`;
}

async function saveNotify(msg) {
  try {
    const r = await post('/api/notifications', { settings: NOTIFY.settings });
    NOTIFY.settings = r.settings;
    if (msg) { msg.textContent = 'Saved.'; msg.className = 'nt-msg small cost-ok'; }
  } catch (e) { if (msg) { msg.textContent = `Not saved: ${e.message}`; msg.className = 'nt-msg small cost-no'; } }
}

function bindNotify() {
  const dlg = $('#alertsDialog');
  $('#alertsBtn').addEventListener('click', async () => {
    dlg.showModal();
    renderNotifyDialog();
    await loadNotify();
    renderNotifyDialog();
  });
  dlg.addEventListener('change', async (e) => {
    const el = e.target;
    const field = el.dataset.ntField;
    if (!field || !NOTIFY) return;
    const s = NOTIFY.settings;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.dataset.ntType) s.types[el.dataset.ntType][field] = value;
    else if (field.startsWith('quiet.')) s.quiet[field.slice(6)] = value;
    else if (field === 'account') s.account = value || null;
    else s[field] = value;
    await saveNotify(dlg.querySelector('.nt-msg'));
    renderNotifyDialog();
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) { dlg.close(); return; } // backdrop click
    if (!e.target.closest('[data-nt-test]')) return;
    const msg = dlg.querySelector('.nt-msg');
    msg.textContent = 'Sending…'; msg.className = 'nt-msg small';
    try { await post('/api/notifications/test', {}); msg.textContent = 'Sent: check the corner of your screen.'; msg.className = 'nt-msg small cost-ok'; } catch (err) { msg.textContent = err.message; msg.className = 'nt-msg small cost-no'; }
    await loadNotify();
    renderNotifyDialog();
    dlg.querySelector('.nt-msg').textContent = 'Sent: check the corner of your screen.';
  });
}
