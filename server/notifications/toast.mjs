// Windows toast notifications via PowerShell and Windows.UI.Notifications. Title and text are passed as environment
// variables (never interpolated into the script) and XML-escaped.
// In the exe, desktop/launcher.cjs sets RUMBLE_TOAST_APP (the tracker's app ID, from its Start menu shortcut) and
// RUMBLE_TOAST_LAUNCH (a rumble-tracker: link: clicking the notification opens the tracker).
import { execFile } from 'node:child_process';
import { POWERSHELL } from '../game/watch.mjs';

// Toasts need a registered app identity; PowerShell's is there on Windows 10 and 11 when the tracker's isn't.
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$t = [Security.SecurityElement]::Escape($env:RT_TITLE)
$b = [Security.SecurityElement]::Escape($env:RT_BODY)
$a = [Security.SecurityElement]::Escape($env:RT_ATTR)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$l = if ($env:RT_LAUNCH) { " activationType='protocol' launch='" + [Security.SecurityElement]::Escape($env:RT_LAUNCH) + "'" } else { '' }
$xml.LoadXml("<toast$l><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text><text placement='attribution'>$a</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:RT_APP).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/** Shows a notification. Resolves to true if Windows accepted it. */
export function showToast(title, body) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, RT_TITLE: String(title).slice(0, 120), RT_BODY: String(body).slice(0, 400), RT_ATTR: 'Rumble Collection Tracker', RT_APP: process.env.RUMBLE_TOAST_APP || POWERSHELL_APP_ID, RT_LAUNCH: process.env.RUMBLE_TOAST_LAUNCH || '' },
    }, (err) => resolve(!err));
  });
}

