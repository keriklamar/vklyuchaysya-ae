# Vklyuchaysya! - diagnostic report (read-only, changes nothing).
# Run as the NORMAL user (not "as administrator"), After Effects may be open or closed.
# Result: printed on screen, saved to Desktop\vklyuchaysya_diagnose.txt and copied to clipboard.
# Source file is ASCII-only on purpose (works via "irm ... | iex" on Windows PowerShell 5.1).

$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.Generic.List[string]
function W([string]$s) { $out.Add($s) | Out-Null }
function H([string]$s) { W ''; W ('=== ' + $s + ' ===') }

W ('Vklyuchaysya diagnose, ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---------- who / where ----------
H 'USER AND SYSTEM'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
W ('whoami           : ' + $id.Name)
W ('elevated (admin) : ' + $isAdmin + '   <- should be False when running this')
W ('USERPROFILE      : ' + $env:USERPROFILE)
W ('APPDATA          : ' + $env:APPDATA)
W ('Documents        : ' + [Environment]::GetFolderPath('MyDocuments'))
W ('OS               : ' + (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version)
W ('PowerShell       : ' + $PSVersionTable.PSVersion)
W ('Logged-in users  : ' + ((Get-Process explorer -IncludeUserName | Select-Object -ExpandProperty UserName -Unique) -join ', '))

# ---------- Adobe apps ----------
H 'ADOBE APPS'
foreach ($root in @('C:\Program Files\Adobe', 'C:\Program Files (x86)\Adobe')) {
    if (Test-Path $root) {
        Get-ChildItem $root -Directory | Where-Object { $_.Name -match 'After Effects|Premiere|Media Encoder' } |
            ForEach-Object { W ('installed: ' + $_.FullName) }
    }
}
$ae = Get-Process AfterFX
if ($ae) { W ('AfterFX.exe running: yes, started ' + ($ae | Select-Object -First 1).StartTime + ', path ' + ($ae | Select-Object -First 1).Path) }
else { W 'AfterFX.exe running: no' }
if (Get-Process 'Adobe Premiere Pro') { W 'Premiere Pro running: yes (panel is for After Effects ONLY - AEFT)' }

# ---------- panel files ----------
H 'PANEL FILES (must be in THIS user profile)'
$ext = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
W ('extensions dir   : ' + $ext + '   exists=' + (Test-Path $ext))
$panel = Join-Path $ext 'AutoPogodaPanel'
$man = Join-Path $panel 'CSXS\manifest.xml'
W ('panel dir        : ' + $panel + '   exists=' + (Test-Path $panel))
W ('manifest.xml     : exists=' + (Test-Path $man))
if (Test-Path $man) {
    $mt = Get-Content $man -Raw
    if ($mt -match 'Host Name="([^"]+)" Version="([^"]+)"') { W ('manifest host    : ' + $Matches[1] + ' ' + $Matches[2]) }
    if ($mt -match 'RequiredRuntime Name="CSXS" Version="([^"]+)"') { W ('manifest CSXS    : ' + $Matches[1]) }
}
foreach ($rel in @('client\index.html', 'client\js\main.js', 'client\js\CSInterface.js', 'client\js\jszip.min.js', 'host\host.jsx')) {
    $f = Join-Path $panel $rel
    if (Test-Path $f) { W ('  ok   ' + $rel + '  ' + (Get-Item $f).Length + ' bytes') } else { W ('  MISSING  ' + $rel) }
}
# panel installed into a DIFFERENT profile (typical "run as other admin" mistake)
W 'panel in other user profiles:'
$found = $false
Get-ChildItem 'C:\Users' -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'AppData\Roaming\Adobe\CEP\extensions\AutoPogodaPanel\CSXS\manifest.xml'
    if (Test-Path $p) { W ('  FOUND in ' + $_.Name); $found = $true }
}
if (-not $found) { W '  (none found / no access)' }
# system-wide CEP folder (not used by installer, but may shadow)
$sys = 'C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AutoPogodaPanel'
W ('system-wide copy : ' + $sys + '   exists=' + (Test-Path $sys))

# ---------- registry ----------
H 'REGISTRY PlayerDebugMode (HKCU of THIS user; must be "1")'
foreach ($n in 8..13) {
    $k = 'HKCU:\Software\Adobe\CSXS.' + $n
    if (Test-Path $k) {
        $v = (Get-ItemProperty $k).PlayerDebugMode
        if ($null -eq $v) { W ('CSXS.' + $n + ' : key exists, PlayerDebugMode MISSING') } else { W ('CSXS.' + $n + ' : PlayerDebugMode = ' + $v) }
    } else { W ('CSXS.' + $n + ' : key does not exist') }
}

# ---------- AE preference: scripts may write files / network ----------
H 'AE PREF: Allow Scripts to Write Files and Access Network'
$prefRoot = Join-Path $env:APPDATA 'Adobe\After Effects'
if (Test-Path $prefRoot) {
    Get-ChildItem $prefRoot -Directory | ForEach-Object {
        $pf = Get-ChildItem $_.FullName -Filter '*Prefs*.txt' | Select-Object -First 1
        if ($pf) {
            $line = Select-String -Path $pf.FullName -Pattern 'SCRIPTING_FILE_NETWORK_SECURITY' | Select-Object -First 1
            if ($line) { W ($_.Name + ' : ' + $line.Line.Trim() + '   (1 = enabled)') } else { W ($_.Name + ' : pref not found in ' + $pf.Name + ' (never saved = probably OFF)') }
        } else { W ($_.Name + ' : no prefs file') }
    }
} else { W ('no folder ' + $prefRoot + ' (AE never started under this user?)') }

# ---------- project, fonts, horoscope ----------
H 'PROJECT / FONTS / HOROSCOPE'
$docs = [Environment]::GetFolderPath('MyDocuments')
$cand = Get-ChildItem $docs -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Graph') }
if ($cand) {
    foreach ($c in $cand) {
        W ('project root     : ' + $c.FullName)
        Get-ChildItem (Join-Path $c.FullName 'Graph') -Filter *.aep | ForEach-Object { W ('  aep: ' + $_.Name + '  ' + [math]::Round($_.Length / 1MB, 1) + ' MB') }
        W ('  horoscope .txt next to Graph: ' + ((Get-ChildItem $c.FullName -Filter *.txt | Where-Object { $_.Name -ne 'README.txt' } | ForEach-Object { $_.Name }) -join ', '))
    }
} else { W 'no "<Documents>\<name>\Graph" folder found (project not installed in Documents; may be in a custom folder)' }
$fonts = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
W ('fonts Cousine    : ' + [bool](Get-ChildItem $fonts -Filter 'Cousine*'))
W ('fonts Manrope    : ' + [bool](Get-ChildItem $fonts -Filter 'Manrope*'))

# ---------- network (the panel pulls weather / rates / namedays) ----------
H 'NETWORK'
W ('curl.exe         : ' + [bool](Get-Command curl.exe))
foreach ($u in @('https://pogoda.by', 'https://api.nbrb.by/exrates/rates?periodicity=0', 'https://kalendarik.com.ua')) {
    try {
        $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 10
        W ($u + ' -> HTTP ' + $r.StatusCode)
    } catch { W ($u + ' -> FAIL: ' + $_.Exception.Message) }
}
W ('proxy            : ' + ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings').ProxyServer))

# ---------- antivirus / Defender ----------
H 'DEFENDER (threats that touched the panel, if readable)'
$t = Get-MpThreatDetection | Where-Object { $_.Resources -match 'AutoPogoda|Vklyuchaysya|CEP' }
if ($t) { $t | ForEach-Object { W ('  ' + $_.InitialDetectionTime + '  ' + ($_.Resources -join '; ')) } } else { W '  nothing found (or no permission to read)' }
$ex = (Get-MpPreference).ExclusionPath
W ('exclusions       : ' + ($ex -join '; '))
W ('3rd-party AV     : ' + ((Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName }) -join ', '))

# ---------- CEP logs ----------
H 'CEP LOGS (last lines mentioning AutoPogoda / errors)'
Get-ChildItem $env:TEMP -Filter '*.log' | Where-Object { $_.Name -match 'AEFT' } | ForEach-Object {
    W ('-- ' + $_.FullName + '  ' + $_.LastWriteTime)
    $pat = if ($_.Name -match 'autopogoda') { 'error|fail|exception|denied' } else { 'autopogoda|not signed|signature' }
    Get-Content $_.FullName -Tail 600 | Where-Object { $_ -match $pat } | Select-Object -Last 15 | ForEach-Object { W ('   ' + $_) }
}

# ---------- save ----------
$text = $out -join "`r`n"
$text
$desk = [Environment]::GetFolderPath('Desktop')
$file = Join-Path $desk 'vklyuchaysya_diagnose.txt'
try { [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($true))); Write-Host ''; Write-Host ('Saved: ' + $file) -ForegroundColor Green } catch { Write-Host 'Could not save file to Desktop' -ForegroundColor Yellow }
try { Set-Clipboard -Value $text; Write-Host 'Copied to clipboard: just paste (Ctrl+V) into the chat.' -ForegroundColor Green } catch { }
