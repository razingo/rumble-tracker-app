# Asks what closing the window should do, in the page's colors. Started by desktop/launcher.cjs when the window was
# closed and the setting is "Ask me". Writes "tray" or "quit", or nothing when the dialog itself is closed.
# Environment: RT_TITLE (window title), RT_EXE (icon), RT_CHECK (build the dialog without showing it, for the tests).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DialogWindow {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  // DWMWA_USE_IMMERSIVE_DARK_MODE; older Windows ignores it
  public static void DarkTitle(IntPtr hwnd) {
    int on = 1;
    DwmSetWindowAttribute(hwnd, 20, ref on, 4);
  }
  // The launcher starts PowerShell hidden, and Windows applies that to the first window shown. Showing this one hidden
  // once uses that up, so the dialog itself appears.
  public static void UseUpHiddenStart(IntPtr hwnd) { ShowWindow(hwnd, 0); }
}
'@

$color = { param($hex) [System.Drawing.ColorTranslator]::FromHtml($hex) }
$panel = & $color '#232842'; $ink = & $color '#f3ead6'; $muted = & $color '#a9a6b8'; $gold = & $color '#ffe08a'

$form = New-Object System.Windows.Forms.Form
$form.Text = $env:RT_TITLE
$form.ClientSize = New-Object System.Drawing.Size(460, 190)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.BackColor = $panel
$form.ForeColor = $ink
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:RT_EXE) } catch { }

$label = {
  param($text, $top, $height, $font, $fore)
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.SetBounds(24, $top, 412, $height)
  $l.Font = $font
  $l.ForeColor = $fore
  $form.Controls.Add($l)
}
& $label 'Close the tracker?' 18 30 (New-Object System.Drawing.Font('Segoe UI Semibold', 15)) $gold
& $label ('The window is closed. The tracker can keep running in the tray, so notifications still arrive, ' +
  'or it can quit.') 52 44 $form.Font $ink
& $label 'Your answer is kept. You can change it in Settings.' 98 22 (New-Object System.Drawing.Font('Segoe UI', 9)) $muted

$button = {
  param($text, $left, $width, $back, $fore, $edge, $result)
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.SetBounds($left, 134, $width, 36)
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderColor = & $color $edge
  $b.FlatAppearance.BorderSize = 2
  $b.BackColor = & $color $back
  $b.ForeColor = & $color $fore
  $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
  $b.Cursor = 'Hand'
  $b.Add_Click({ $form.Tag = $result; $form.Close() }.GetNewClosure())
  $form.Controls.Add($b)
  $b
}
$keep = & $button 'Keep running in the tray' 24 220 '#1f63c9' '#ffffff' '#4aa3ff' 'tray'
& $button 'Quit the tracker' 256 180 '#f2b33d' '#3a2208' '#b9721a' 'quit' | Out-Null
$form.AcceptButton = $keep
$form.Add_HandleCreated({ [DialogWindow]::DarkTitle($form.Handle) })
$form.Add_Shown({ $form.Activate() })

if ($env:RT_CHECK) { 'built'; exit 0 }
[DialogWindow]::UseUpHiddenStart($form.Handle)
[void]$form.ShowDialog()
if ($form.Tag) { [Console]::Out.WriteLine($form.Tag) }
