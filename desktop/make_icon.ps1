# Creates desktop/icon.ico and web/favicon.ico from gamedata/art/kobold-miner.webp.
# Usage: powershell -ExecutionPolicy Bypass -File desktop\make_icon.ps1 (needs gamedata/; .webp decoding needs
# Windows 11 or the WebP Image Extensions). PNG-encoded sizes: full portrait at 48-256 px, face crop at 16-32 px.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'gamedata\art\kobold-miner.webp'
$out = Join-Path $PSScriptRoot 'icon.ico'

$dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]$src, 'PreservePixelFormat', 'OnLoad')
$img = $dec.Frames[0]
$full = New-Object System.Windows.Rect 0, 0, $img.PixelWidth, $img.PixelHeight
$face = New-Object System.Windows.Rect 20, 50, 200, 200   # in the 256 px portrait

function Render([int]$size, [System.Windows.Rect]$crop) {
  $dv = New-Object System.Windows.Media.DrawingVisual
  $dc = $dv.RenderOpen()
  $r = [Math]::Max(2, $size * 0.18)
  $box = New-Object System.Windows.Rect 0, 0, $size, $size
  $dc.PushClip((New-Object System.Windows.Media.RectangleGeometry $box, $r, $r))
  $cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap $img, (New-Object System.Windows.Int32Rect $crop.X, $crop.Y, $crop.Width, $crop.Height)
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($dv, 'HighQuality')
  $dc.DrawImage($cropped, $box)
  $dc.Pop()
  # thin dark gold rim
  $pen = New-Object System.Windows.Media.Pen ((New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 120, 72, 12)))), ([Math]::Max(1, $size / 32))
  $h = $pen.Thickness / 2
  $dc.DrawRoundedRectangle($null, $pen, (New-Object System.Windows.Rect $h, $h, ($size - 2 * $h), ($size - 2 * $h)), $r, $r)
  $dc.Close()
  $bmp = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $size, $size, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
  $bmp.Render($dv)
  $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bmp))
  $ms = New-Object System.IO.MemoryStream
  $enc.Save($ms)
  return ,$ms.ToArray()
}

$sizes = 256, 128, 64, 48, 32, 24, 16
$pngs = foreach ($s in $sizes) { ,(Render $s $(if ($s -le 32) { $face } else { $full })) }

# ICONDIR, one ICONDIRENTRY per image, PNG data
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$d.Length); $w.Write([uint32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
$w.Flush()
[System.IO.File]::WriteAllBytes($out, $ms.ToArray())
# also the page's favicon (taskbar icon of the app window)
[System.IO.File]::WriteAllBytes((Join-Path $root 'web\favicon.ico'), $ms.ToArray())
"Wrote $out ($($ms.Length) bytes, sizes $($sizes -join ', '))"
