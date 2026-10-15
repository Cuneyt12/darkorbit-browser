# ============================================================
#  Astra Browser kurulum betigi (turnkey)
#  Kurulu Electron 11.5 (Chromium 87) runtime'ini taban alip
#  kendi app'imizi yerlestirir, "Astra Browser.exe" uretir ve
#  astra2.png logosunu pencere/kisayol ikonu olarak uygular.
# ============================================================
$ErrorActionPreference = 'Stop'

$src    = Join-Path $env:LOCALAPPDATA 'Programs\darkorbit-client'
$dst    = Join-Path $env:LOCALAPPDATA 'Programs\astra-browser'
$appSrc = Join-Path $PSScriptRoot 'electron'

if (!(Test-Path $src)) {
    throw "Electron kaynagi bulunamadi: $src"
}
if (!(Test-Path (Join-Path $appSrc 'main.js'))) {
    throw "main.js bulunamadi: $appSrc"
}
if (!(Test-Path (Join-Path $appSrc 'icon.png'))) {
    throw "icon.png bulunamadi: $appSrc (astra2.png kopyalanmali)"
}

# PNG -> cok boyutlu ICO uretici (Windows'da kisayol/exe ikonu icin)
function New-IcoFromPng {
    param([string]$PngPath, [string]$IcoPath)
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Bitmap]::FromFile($PngPath)
    try {
        $sizes = 16, 24, 32, 48, 64, 128, 256
        $pngs = New-Object System.Collections.ArrayList
        foreach ($s in $sizes) {
            $bmp = New-Object System.Drawing.Bitmap $s, $s
            try {
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try {
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $g.DrawImage($src, 0, 0, $s, $s)
                } finally { $g.Dispose() }
                $ms = New-Object System.IO.MemoryStream
                try {
                    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                    [void]$pngs.Add($ms.ToArray())
                } finally { $ms.Dispose() }
            } finally { $bmp.Dispose() }
        }

        $fs = [System.IO.File]::Create($IcoPath)
        $bw = New-Object System.IO.BinaryWriter $fs
        try {
            $bw.Write([UInt16]0)             # reserved
            $bw.Write([UInt16]1)             # type = icon
            $bw.Write([UInt16]$sizes.Count)  # count
            $offset = 6 + 16 * $sizes.Count
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $s = $sizes[$i]
                $dim = if ($s -ge 256) { 0 } else { $s }
                $bw.Write([Byte]$dim)        # width
                $bw.Write([Byte]$dim)        # height
                $bw.Write([Byte]0)           # color count
                $bw.Write([Byte]0)           # reserved
                $bw.Write([UInt16]1)         # planes
                $bw.Write([UInt16]32)        # bits per pixel
                $bw.Write([UInt32]$pngs[$i].Length)
                $bw.Write([UInt32]$offset)
                $offset += $pngs[$i].Length
            }
            foreach ($data in $pngs) { $bw.Write($data) }
        } finally { $bw.Flush(); $bw.Close(); $fs.Close() }
    } finally { $src.Dispose() }
}

if (Test-Path $dst) {
    Remove-Item -Recurse -Force $dst
}
New-Item -ItemType Directory -Path $dst | Out-Null

# 1) Electron runtime'ini kopyala (kaiserdj app.asar ve gereksiz dosyalar haric)
robocopy $src $dst /E `
    /XF "app.asar" "app-update.yml" "Uninstall DarkOrbit Client.exe" "libpepflashplayer.so" "PepperFlashPlayer.plugin" `
    /XD "darkDev" `
    /NFL /NDL /NJH /NJS /NP | Out-Null

# 2) Ana exe'yi yeniden adlandir
Rename-Item -Path (Join-Path $dst 'DarkOrbit Client.exe') -NewName 'Astra Browser.exe' -Force

# 3) Kendi app'imizi + logoyu resources\app icine koy (tum dosyalar)
$appDst = Join-Path $dst 'resources\app'
if (Test-Path $appDst) { Remove-Item -Recurse -Force $appDst }
New-Item -ItemType Directory -Path $appDst | Out-Null
robocopy $appSrc $appDst /E /NFL /NDL /NJH /NJS /NP | Out-Null

# 4) Logo'dan ICO uret (kisayol ikonu icin)
$ico = Join-Path $dst 'Astra Browser.ico'
New-IcoFromPng -PngPath (Join-Path $appSrc 'icon.png') -IcoPath $ico

# 5) Masaustu kisayolunu logoyla olustur
$exe = Join-Path $dst 'Astra Browser.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
foreach ($name in @('Astra Browser.lnk', 'DarkOrbit Browser.lnk')) {
    $l = Join-Path $desktop $name
    if (Test-Path $l) { Remove-Item -Force $l }
}
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Astra Browser.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dst
$lnk.IconLocation = "$ico,0"
$lnk.Description = 'Astra Browser'
$lnk.Save()

# 6) Kontroller
$flash = Join-Path $dst 'resources\flash\pepflashplayer.dll'
Write-Output ("exe   : {0} ({1})" -f $exe, (Test-Path $exe))
Write-Output ("flash : {0} ({1})" -f $flash, (Test-Path $flash))
Write-Output ("icon  : {0} ({1})" -f $ico, (Test-Path $ico))
Write-Output ("lnk   : {0}" -f (Join-Path $desktop 'Astra Browser.lnk'))
Write-Output "KURULUM TAMAM: $dst"
