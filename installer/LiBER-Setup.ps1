# installer/LiBER-Setup.ps1 — the Windows wizard.
#
#   Double-click LiBER-Setup.cmd, or:
#     powershell -ExecutionPolicy Bypass -File installer\LiBER-Setup.ps1
#
# Silent (used by CI and tests):
#     powershell -ExecutionPolicy Bypass -File installer\LiBER-Setup.ps1 `
#       -Silent -InstallDir C:\temp\LiBER -DataDir C:\temp\LiBER-data -NoShortcuts -NoLaunch
#
# What it does: copies the payload into %ProgramFiles%\LiBER, keeps user data in
# %LOCALAPPDATA%\LiBER (so a read-only program directory is not a problem),
# creates Start Menu / desktop shortcuts, and registers an uninstaller.
param(
  [switch]$Silent,
  [string]$InstallDir,
  [string]$DataDir,
  [switch]$NoShortcuts,
  [switch]$NoLaunch,
  [switch]$NoRegistry
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$AppName = 'LiBER'
$Publisher = 'Arthov Labs'
$Payload = Join-Path $PSScriptRoot 'payload'
$Script:Installed = $false

if (-not (Test-Path (Join-Path $Payload 'app\LiBER.exe'))) {
  [System.Windows.Forms.MessageBox]::Show(
    "The installer payload is missing.`n`nBuild it first:`n  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\build.ps1`"",
    'LiBER Setup') | Out-Null
  exit 1
}

$Version = '0.0.0'
try {
  $pkg = Get-Content (Join-Path $Payload 'app\package.json') -Raw | ConvertFrom-Json
  if ($pkg.version) { $Version = $pkg.version }
} catch { }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $InstallDir) { $InstallDir = Join-Path $env:ProgramFiles $AppName }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA $AppName }

# ── elevation ───────────────────────────────────────────────────────────────
if (-not $Silent -and -not (Test-Admin)) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  Start-Process powershell.exe -Verb RunAs -ArgumentList $args
  exit
}

function Install-Files {
  param([scriptblock]$Progress)
  if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

  $items = Get-ChildItem $Payload -Force
  $i = 0
  foreach ($item in $items) {
    $i++
    if ($Progress) { & $Progress ("Installing {0} ({1}/{2})" -f $item.Name, $i, $items.Count) $i $items.Count }
    Copy-Item $item.FullName -Destination $InstallDir -Recurse -Force
  }

  # remember where user data lives, so the uninstaller and launcher agree
  $meta = [ordered]@{
    name = $AppName; version = $Version; installDir = $InstallDir; dataDir = $DataDir
    installedAt = (Get-Date).ToString('o')
  }
  $meta | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'install.json') -Encoding UTF8
}

function New-Shortcut {
  param([string]$Path)
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($Path)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\launch.ps1`" -InstallDir `"$InstallDir`" -DataDir `"$DataDir`""
  $lnk.WorkingDirectory = $DataDir
  $lnk.IconLocation = (Join-Path $InstallDir 'app\LiBER.exe') + ',0'
  $lnk.Description = 'LiBER — autonomous agent orchestrator'
  $lnk.Save()
}

function Install-Shortcuts {
  $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
  New-Shortcut -Path $startMenu
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
  New-Shortcut -Path $desktop
  return @($startMenu, $desktop)
}

function Install-Registry {
  $hive = if (Test-Admin) { 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' }
  $key = Join-Path $hive $AppName
  New-Item -Path $key -Force | Out-Null
  $sizeKb = [int](((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum) / 1KB)
  $values = @{
    DisplayName = $AppName
    DisplayVersion = $Version
    Publisher = $Publisher
    InstallLocation = $InstallDir
    DisplayIcon = (Join-Path $InstallDir 'app\LiBER.exe')
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`" -InstallDir `"$InstallDir`" -DataDir `"$DataDir`""
    QuietUninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`" -InstallDir `"$InstallDir`" -DataDir `"$DataDir`" -PurgeData"
    EstimatedSize = $sizeKb
    NoModify = 1
    NoRepair = 1
  }
  foreach ($k in $values.Keys) {
    New-ItemProperty -Path $key -Name $k -Value $values[$k] -PropertyType ($(if ($values[$k] -is [int]) { 'DWord' } else { 'String' })) -Force | Out-Null
  }
  return $key
}

# ── silent path ─────────────────────────────────────────────────────────────
if ($Silent) {
  Install-Files
  if (-not $NoShortcuts) { Install-Shortcuts | Out-Null }
  if (-not $NoRegistry) { Install-Registry | Out-Null }
  Write-Host "LiBER $Version installed to $InstallDir (data: $DataDir)" -ForegroundColor Green
  if (-not $NoLaunch) { Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$InstallDir\launch.ps1`"", '-InstallDir', "`"$InstallDir`"", '-DataDir', "`"$DataDir`"") -WindowStyle Hidden }
  exit 0
}

# ── wizard ──────────────────────────────────────────────────────────────────
$font = New-Object System.Drawing.Font('Segoe UI', 9)
$form = New-Object System.Windows.Forms.Form
$form.Text = "LiBER Setup $Version"
$form.Size = New-Object System.Drawing.Size(700, 520)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 20)
$form.ForeColor = [System.Drawing.Color]::FromArgb(235, 235, 235)
$form.Font = $font

$title = New-Object System.Windows.Forms.Label
$title.Text = '◢  L i B E R  ◣'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(229, 178, 92)
$title.SetBounds(24, 18, 420, 40)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Autonomous agent orchestrator · version $Version"
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 155)
$subtitle.SetBounds(26, 56, 520, 20)
$form.Controls.Add($subtitle)

# pages
$pages = @{}
foreach ($name in @('welcome', 'location', 'options', 'progress', 'done')) {
  $p = New-Object System.Windows.Forms.Panel
  $p.SetBounds(24, 90, 636, 320)
  $p.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27)
  $p.Visible = $false
  $form.Controls.Add($p)
  $pages[$name] = $p
}

# welcome
$w = New-Object System.Windows.Forms.Label
$w.Text = "This wizard installs LiBER for all users of this machine.`n`n" +
          "  •  program files  →  $InstallDir`n" +
          "  •  your data       →  $DataDir`n`n" +
          "Your sessions, memory and vault stay in your own profile, so the program`n" +
          "directory can be read-only and updates never touch your data.`n`n" +
          "The daemon starts automatically when you open LiBER."
$w.SetBounds(22, 22, 590, 250)
$w.ForeColor = [System.Drawing.Color]::FromArgb(210, 210, 215)
$pages.welcome.Controls.Add($w)

# location
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'Install folder'
$lbl.SetBounds(22, 22, 200, 20)
$pages.location.Controls.Add($lbl)
$txtInstall = New-Object System.Windows.Forms.TextBox
$txtInstall.Text = $InstallDir
$txtInstall.SetBounds(22, 46, 460, 26)
$pages.location.Controls.Add($txtInstall)
$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = 'Browse…'
$btnBrowse.SetBounds(492, 45, 90, 27)
$pages.location.Controls.Add($btnBrowse)

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = 'Data folder (sessions, memory, vault)'
$lbl2.SetBounds(22, 90, 320, 20)
$pages.location.Controls.Add($lbl2)
$txtData = New-Object System.Windows.Forms.TextBox
$txtData.Text = $DataDir
$txtData.SetBounds(22, 114, 460, 26)
$pages.location.Controls.Add($txtData)
$btnBrowse2 = New-Object System.Windows.Forms.Button
$btnBrowse2.Text = 'Browse…'
$btnBrowse2.SetBounds(492, 113, 90, 27)
$pages.location.Controls.Add($btnBrowse2)

$note = New-Object System.Windows.Forms.Label
$note.Text = "A browser window is not used: LiBER's window talks to a local daemon on 127.0.0.1:4567."
$note.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 145)
$note.SetBounds(22, 160, 580, 40)
$pages.location.Controls.Add($note)

# options
$chkMenu = New-Object System.Windows.Forms.CheckBox
$chkMenu.Text = 'Start Menu shortcut'
$chkMenu.Checked = $true
$chkMenu.SetBounds(22, 24, 300, 24)
$pages.options.Controls.Add($chkMenu)
$chkDesktop = New-Object System.Windows.Forms.CheckBox
$chkDesktop.Text = 'Desktop shortcut'
$chkDesktop.Checked = $true
$chkDesktop.SetBounds(22, 54, 300, 24)
$pages.options.Controls.Add($chkDesktop)
$chkLaunch = New-Object System.Windows.Forms.CheckBox
$chkLaunch.Text = 'Open LiBER when the installation finishes'
$chkLaunch.Checked = $true
$chkLaunch.SetBounds(22, 84, 400, 24)
$pages.options.Controls.Add($chkLaunch)

# progress
$lblProgress = New-Object System.Windows.Forms.Label
$lblProgress.Text = 'Installing…'
$lblProgress.SetBounds(22, 22, 500, 20)
$pages.progress.Controls.Add($lblProgress)
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(22, 50, 590, 18)
$bar.Maximum = 100
$pages.progress.Controls.Add($bar)
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.SetBounds(22, 82, 590, 200)
$log.BackColor = [System.Drawing.Color]::FromArgb(16, 16, 18)
$log.ForeColor = [System.Drawing.Color]::FromArgb(180, 200, 180)
$log.BorderStyle = 'FixedSingle'
$pages.progress.Controls.Add($log)

# done
$doneLabel = New-Object System.Windows.Forms.Label
$doneLabel.Text = 'LiBER is installed.'
$doneLabel.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$doneLabel.SetBounds(22, 24, 400, 30)
$pages.done.Controls.Add($doneLabel)
$doneDetail = New-Object System.Windows.Forms.Label
$doneDetail.SetBounds(22, 64, 590, 180)
$doneDetail.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 205)
$pages.done.Controls.Add($doneDetail)

# footer buttons
$btnBack = New-Object System.Windows.Forms.Button
$btnBack.Text = 'Back'
$btnBack.SetBounds(410, 430, 90, 32)
$form.Controls.Add($btnBack)
$btnNext = New-Object System.Windows.Forms.Button
$btnNext.Text = 'Next'
$btnNext.SetBounds(510, 430, 90, 32)
$form.Controls.Add($btnNext)
$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = 'Cancel'
$btnCancel.SetBounds(610, 430, 90, 32)
$form.Controls.Add($btnCancel)

$script:step = 0
$order = @('welcome', 'location', 'options', 'progress', 'done')

function Show-Step($i) {
  $script:step = $i
  foreach ($name in $order) { $pages[$name].Visible = ($order[$i] -eq $name) }
  $btnBack.Enabled = ($i -gt 0 -and $i -lt 3)
  switch ($i) {
    0 { $btnNext.Text = 'Next'; $btnNext.Enabled = $true }
    1 { $btnNext.Text = 'Next'; $btnNext.Enabled = $true }
    2 { $btnNext.Text = 'Install'; $btnNext.Enabled = $true }
    3 { $btnNext.Text = 'Installing…'; $btnNext.Enabled = $false }
    4 { $btnNext.Text = 'Close'; $btnNext.Enabled = $true }
  }
}

$btnBrowse.add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.SelectedPath = $txtInstall.Text
  if ($dlg.ShowDialog() -eq 'OK') { $txtInstall.Text = $dlg.SelectedPath }
})
$btnBrowse2.add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.SelectedPath = $txtData.Text
  if ($dlg.ShowDialog() -eq 'OK') { $txtData.Text = $dlg.SelectedPath }
})

$btnCancel.add_Click({ if ($script:step -eq 3) { return }; $form.Close() })
$btnBack.add_Click({ if ($script:step -gt 0) { Show-Step ($script:step - 1) } })

$btnNext.add_Click({
  switch ($script:step) {
    0 { Show-Step 1 }
    1 {
      $script:InstallDir = $txtInstall.Text.Trim()
      $script:DataDir = $txtData.Text.Trim()
      if (-not $script:InstallDir) { [System.Windows.Forms.MessageBox]::Show('Choose an install folder.', 'LiBER Setup') | Out-Null; return }
      Show-Step 2
    }
    2 {
      Show-Step 3
      $script:InstallDir = $txtInstall.Text.Trim()
      $script:DataDir = $txtData.Text.Trim()
      try {
        Install-Files -Progress {
          param($msg, $i, $total)
          $lblProgress.Text = $msg
          $bar.Value = [int](($i / [Math]::Max(1, $total)) * 100)
          $log.AppendText("$msg`r`n")
          [System.Windows.Forms.Application]::DoEvents()
        }
        $bar.Value = 100
        $lblProgress.Text = 'Finishing…'
        $created = @()
        if ($chkMenu.Checked) {
          $sm = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
          New-Shortcut -Path $sm; $created += $sm
        }
        if ($chkDesktop.Checked) {
          $dk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
          New-Shortcut -Path $dk; $created += $dk
        }
        $regKey = Install-Registry
        $log.AppendText("registry: $regKey`r`n")
        $script:Installed = $true
        $doneDetail.Text = "Program:  $($script:InstallDir)`r`nData:     $($script:DataDir)`r`nShortcuts: `r`n" +
          (($created | ForEach-Object { "  $_" }) -join "`r`n") + "`r`nUninstall from Settings → Apps, or run:`r`n  $($script:InstallDir)\uninstall.ps1"
        Show-Step 4
        if ($chkLaunch.Checked) {
          Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($script:InstallDir)\launch.ps1`"", '-InstallDir', "`"$($script:InstallDir)`"", '-DataDir', "`"$($script:DataDir)`"") -WindowStyle Hidden
        }
      } catch {
        [System.Windows.Forms.MessageBox]::Show("Installation failed:`n`n$($_.Exception.Message)", 'LiBER Setup') | Out-Null
        Show-Step 2
      }
    }
    4 { $form.Close() }
  }
})

Show-Step 0
[void]$form.ShowDialog()
