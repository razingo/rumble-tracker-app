// New tracker versions: the banner when game data needs a newer version, and the update pop-up (Download now, Later).
import { alertDialog } from './dialogs.js';
import { schedulePoll, poll } from './app.js';
import { when } from './calendar.js';
import { $, esc, post, openExternal, state, RELEASES_URL } from './core.js';

/** Banner when a newer tracker version is needed for game-data updates, or when the game is newer than the data. */
export function renderDataBanner() {
  const el = $('#dataBanner');
  const d = state?.dataStatus;
  if (!el) return;
  if (d?.pack?.needsAppUpdate) {
    el.hidden = false;
    el.innerHTML = `<b>A newer version of the tracker is needed.</b> New game data can't be verified by this version, so
      it isn't installed. Download the latest RumbleTracker from GitHub Releases; your data is kept.
      <button class="chip" data-open-releases>Download the latest version</button>`;
    return;
  }
  el.hidden = !d?.stale;
  if (!d?.stale) return;
  el.innerHTML = `<b>The game was updated to ${esc(d.gameBuild)}.</b> The tracker's game data is from ${esc(d.dataBuild)}, so new minis,
    events or shop offers may be missing or unnamed until a data update arrives${d.pack?.configured ? ' (it checks for one every 6 hours)' : ''}.
    Your own progress is read from the game as usual.`;
}

/**
 * Pop-up for a new tracker version (state.update). Download now: the exe downloads, verifies and installs it, then
 * restarts; from source (or without download checksums) it opens GitHub Releases. Later: hidden until the tracker
 * restarts.
 */
export let updateShown = null; // what the dialog shows: '<version>:<state>'
export function renderUpdate() {
  const dlg = $('#updateDialog');
  const u = state?.update;
  // while restarting, the server is gone for a moment: keep showing it
  const busy = u && (u.state === 'downloading' || u.state === 'restarting');
  const show = u && (busy || !u.later);
  if (!show && !(updateShown?.endsWith(':restarting') && state?.connError)) {
    if (dlg.open) dlg.close();
    updateShown = null;
    return;
  }
  if (!u) return;
  const pct = u.total ? Math.min(100, Math.floor((u.done / u.total) * 100)) : null;
  const key = `${u.version}:${u.state}:${u.error || ''}:${pct}:${u.state === 'downloading' && !u.total ? Math.floor(u.done / 1048576) : ''}`;
  if (key !== updateShown) {
    updateShown = key;
    const head = `<div class="nt-head"><h2>Version ${esc(u.version)} is available</h2></div>`;
    let body;
    if (u.state === 'downloading') {
      const mb = (n) => (n / 1048576).toFixed(1);
      body = `<p>Downloading the new version… ${pct != null ? `${pct}% (${mb(u.done)} of ${mb(u.total)} MB)` : `${mb(u.done || 0)} MB`}</p>
        <div class="bar"><span style="width:${pct ?? 0}%"></span></div>`;
    }
    else if (u.state === 'restarting') body = '<p>Installing: the tracker restarts in a moment and this window reloads by itself.</p>';
    else {
      body = `${u.state === 'failed' ? `<p class="cost-no">The update didn't work: ${esc(u.error || 'unknown error')}</p>` : ''}
        <p>${u.auto ? 'The tracker can download and install it now, then restart. Your data is kept.' : 'Download it from GitHub Releases; your data is kept.'}</p>
        <div class="nt-actions"><button class="btn" data-update-now>${u.auto && u.state !== 'failed' ? 'Download now' : 'Open GitHub Releases'}</button>
          <button class="chip" data-update-later>Later</button></div>`;
    }
    dlg.innerHTML = `<div class="nt-form">${head}${body}</div>`;
  }
  if (!dlg.open) dlg.showModal();
}

export async function updateNow() {
  const u = state?.update;
  if (!u) return;
  if (!u.auto || u.state === 'failed') { openExternal(RELEASES_URL); return updateLater(); }
  try { await post('/api/update', {}); } catch (e) { alertDialog(e.message, { title: 'The update could not start' }); }
  await poll();
  schedulePoll();
}
export async function updateLater() {
  try { await post('/api/update/later', {}); } catch { /* the server is gone */ }
  if (state?.update) state.update.later = true;
  renderUpdate();
}
