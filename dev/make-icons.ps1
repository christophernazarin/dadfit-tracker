# Draws the home-screen icons into ..\icons. Run: powershell -File dev\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'
function Draw($size, $file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#15171a'))
  $orange = [System.Drawing.ColorTranslator]::FromHtml('#ff5a2e')
  # a weight plate: orange disc with a dark hub, like the dots in the tally
  $m = $size * 0.16
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $orange), $m, $m, $size - 2*$m, $size - 2*$m)
  $hub = $size * 0.16
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 21, 23, 26))), ($size-$hub)/2, ($size-$hub)/2, $hub, $hub)
  $font = New-Object System.Drawing.Font 'Arial Narrow', ($size * 0.30), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ($size * 0.04), $size, $size
  $g.DrawString('DF', $font, [System.Drawing.Brushes]::White, $rect, $sf)
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
Draw 180 'apple-touch-icon.png'
Draw 192 'icon-192.png'
Draw 512 'icon-512.png'
