// The Settings dialog: Start with Windows and the notifications. The server keeps the settings and sends the
// notifications, also while the page is closed.
import { $, getJson, post, state } from './core.js';
import { esc, dateTime } from './lib/format.js';

let notify = null; // { settings, types, log, pending, playing }
let general = null; // { startWithWindows }, null when running from source

async function loadSettings() {
  [notify, general] = await Promise.all([
    getJson('/api/notifications', 'the notification settings'),
    getJson('/api/settings', 'the settings'),
  ]);
}

function renderSettings() {
  const dlg = $('#settingsDialog');
  if (!notify) {
    dlg.innerHTML = '<p>Loading…</p>';
    return;
  }
  const s = notify.settings;
  const accounts = state?.accounts || [];
  const row = (t) => {
    const v = s.types[t.id];
    return `<tr>
      <td><label class="notify-on"><input type="checkbox" data-notify-type="${t.id}" data-notify-field="on"
        ${v.on ? 'checked' : ''}> ${esc(t.label)}</label>
        ${t.hoursBefore ? `<span class="notify-hours">· warn <input type="number" min="1" max="72"
          value="${v.hoursBefore}" data-notify-type="${t.id}" data-notify-field="hoursBefore"> h before the end</span>` : ''}</td>
      <td class="notify-play"><input type="checkbox" data-notify-type="${t.id}" data-notify-field="whenPlaying"
        ${v.whenPlaying ? 'checked' : ''} ${v.on ? '' : 'disabled'} aria-label="Also while the game is running: ${esc(t.label)}"></td>
    </tr>`;
  };
  dlg.innerHTML = `<form method="dialog" class="dialog-form">
    <div class="dialog-head"><h2>Settings</h2><button class="chip" value="close" aria-label="Close">✕</button></div>
    <h3>General</h3>
    ${general?.startWithWindows == null
    ? '<p class="muted small">Start with Windows is available in RumbleTracker.exe.</p>'
    : `<label class="dialog-toggle"><input type="checkbox" data-setting="startWithWindows"
      ${general.startWithWindows ? 'checked' : ''}> Start with Windows</label>
      <p class="muted small">Starts in the tray when you sign in to Windows (no window), so notifications arrive
        without opening the tracker.</p>`}
    <span class="dialog-msg small" data-setting-message></span>
    <h3>Notifications</h3>
    <p class="muted small">They keep coming while the tracker runs, even with this window closed.</p>
    <label class="dialog-toggle"><input type="checkbox" data-notify-field="enabled"
      ${s.enabled ? 'checked' : ''}> Send notifications</label>
    <label class="notify-acc">For <select data-notify-field="account">
      <option value="">all accounts</option>
      ${accounts.map((a) => `<option value="${a.id}" ${s.account === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
    </select></label>
    <table class="notify-table${s.enabled ? '' : ' off'}">
      <thead><tr><th></th><th title="When unticked, this isn't sent while the game is running">Also while<br>playing</th></tr></thead>
      <tbody>${notify.types.map(row).join('')}</tbody>
    </table>
    <p class="muted small">Types left unticked under "Also while playing" are skipped while the game is
      running${notify.playing ? ' (it is running now)' : ''}. Reward goals are set in an event's reward tree on the Calendar.</p>
    <div class="notify-quiet">
      <label><input type="checkbox" data-notify-field="quiet.on" ${s.quiet.on ? 'checked' : ''}> Quiet hours</label>
      <input type="time" data-notify-field="quiet.from" value="${esc(s.quiet.from)}"> – <input type="time"
        data-notify-field="quiet.to" value="${esc(s.quiet.to)}">
      <span class="muted small">held until they end${notify.pending ? ` · ${notify.pending} waiting` : ''}</span>
    </div>
    <div class="dialog-actions"><button type="button" class="btn" data-notify-test>Send a test notification</button><span
      class="dialog-msg small"></span></div>
    <h3>Recent</h3>
    ${notify.log.length ? `<ul class="notify-log">${notify.log.map((n) =>
      `<li><span class="muted small">${esc(dateTime(n.t))}</span> <b>${esc(n.title)}</b> <span
      class="small">${esc(n.body)}</span>${n.delivered ? '' : ' <span class="cost-no small">(not ' +
      'delivered)</span>'}</li>`).join('')}</ul>` : '<p class="muted small">Nothing sent yet.</p>'}
  </form>`;
}

async function saveNotifications(msg) {
  try {
    const r = await post('/api/notifications', { settings: notify.settings });
    notify.settings = r.settings;
    if (msg) { msg.textContent = 'Saved.'; msg.className = 'dialog-msg small cost-ok'; }
  } catch (e) { if (msg) { msg.textContent = `Not saved. ${e.message}`; msg.className = 'dialog-msg small cost-no'; } }
}

export function bindSettings() {
  const dlg = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', async () => {
    dlg.showModal();
    renderSettings();
    try {
      await loadSettings();
      renderSettings();
    } catch (err) {
      dlg.innerHTML = `<form method="dialog" class="dialog-form">
        <div class="dialog-head"><h2>Settings</h2><button class="chip" value="close" aria-label="Close">✕</button></div>
        <p class="dialog-msg small cost-no">${esc(err.message)}</p></form>`;
    }
  });
  dlg.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.setting) {
      const msg = dlg.querySelector('[data-setting-message]');
      try {
        general = await post('/api/settings', { [el.dataset.setting]: el.checked });
        msg.textContent = 'Saved.'; msg.className = 'dialog-msg small cost-ok';
      } catch (err) { el.checked = !el.checked; msg.textContent = `Not saved. ${err.message}`; msg.className = 'dialog-msg small cost-no'; }
      return;
    }
    const field = el.dataset.notifyField;
    if (!field || !notify) return;
    const s = notify.settings;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.dataset.notifyType) s.types[el.dataset.notifyType][field] = value;
    else if (field.startsWith('quiet.')) s.quiet[field.slice(6)] = value;
    else if (field === 'account') s.account = value || null;
    else s[field] = value;
    await saveNotifications(dlg.querySelector('.dialog-msg:not([data-setting-message])'));
    renderSettings();
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) { dlg.close(); return; } // backdrop click
    if (!e.target.closest('[data-notify-test]')) return;
    const msg = dlg.querySelector('.dialog-msg:not([data-setting-message])');
    msg.textContent = 'Sending…'; msg.className = 'dialog-msg small';
    let text = 'Sent. Check the corner of your screen.', cls = 'dialog-msg small cost-ok';
    try { await post('/api/notifications/test', {}); } catch (err) { text = err.message; cls = 'dialog-msg small cost-no'; }
    await loadSettings();
    renderSettings();
    const shown = dlg.querySelector('.dialog-msg:not([data-setting-message])');
    shown.textContent = text; shown.className = cls;
  });
}
