# Tray icon of RumbleTracker.exe (started by desktop/launcher.cjs, Windows Forms).
# Talks to the launcher through standard output, one line each: "ready" (icon shown), "open" (open the window),
# "quit" (Quit the tracker), "shutdown" (Windows is signing out or shutting down), "game 1" / "game 0" (whether
# Warcraft Rumble runs; sent when it changes). Exits when the tracker process ends.
# Environment: RT_TITLE, RT_DATA (data folder), RT_EXE (icon), RT_PARENT (tracker process id), RT_GAME (the game's
# process name).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }
# fallback icon, drawn in code
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 180, 50))), 1, 1, 30, 30)
$g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 110, 60, 10)), 2), 2, 2, 28, 28)
$font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 70, 35, 5))
$g.DrawString('R', $font, $ink, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $sf)
$g.Dispose()
$tray = New-Object System.Windows.Forms.NotifyIcon
# the exe's icon, or the fallback when it can't be read
try { $tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:RT_EXE) }
catch { $tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) }
$tray.Text = $env:RT_TITLE
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open tracker')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$folder = $menu.Items.Add('Open data folder')
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit the tracker')
$open.add_Click({ Say 'open' })
$folder.add_Click({ Start-Process explorer.exe -ArgumentList ('"' + $env:RT_DATA + '"') })
$quit.add_Click({ $tray.Visible = $false; Say 'quit'; [System.Windows.Forms.Application]::Exit() })
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Say 'open' } })
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$parent = [int]$env:RT_PARENT
# When Windows signs out or shuts down, the tracker is told so it can write its backup and stop, and it gets a few
# seconds for that. A hidden top-level window receives WM_ENDSESSION, which takes a little C#.
try {
  Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Diagnostics; using System.Windows.Forms;
public class RtEndSession : NativeWindow {
  int parent;
  public RtEndSession(int parent) { this.parent = parent; CreateHandle(new CreateParams()); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x16 && m.WParam != IntPtr.Zero) {
      Console.Out.WriteLine("shutdown"); Console.Out.Flush();
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < 4000) { try { Process.GetProcessById(parent); } catch { break; } System.Threading.Thread.Sleep(100); }
    }
    base.WndProc(ref m);
  }
}
'@
  $endSession = New-Object RtEndSession $parent
} catch { [Console]::Error.WriteLine("shutdown watch: $_") }
# Every 2 seconds: exit when the tracker process has ended, and report a change in whether Warcraft Rumble runs.
$global:lastGame = ''
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  try { [void][System.Diagnostics.Process]::GetProcessById($parent) }
  catch { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
  $game = if ([System.Diagnostics.Process]::GetProcessesByName($env:RT_GAME).Length) { 'game 1' } else { 'game 0' }
  if ($game -ne $global:lastGame) { $global:lastGame = $game; Say $game }
})
$timer.Start()
Say 'ready'
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
