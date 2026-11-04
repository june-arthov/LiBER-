; installer/liber.nsi — one-file Windows installer for LiBER (NSIS 3).
;
; Built by build-installer.ps1:
;   makensis /DVERSION=0.5.4 /DPAYLOAD=... /DICON=... /DREQUESTLEVEL=admin liber.nsi
;
; Inno Setup was tried first and its setups would not run on this Windows build
; (a minimal hello-world installer exited 1 before it could even open a log), so
; the installer is NSIS, which every Windows version has run for decades.

Unicode true

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef PAYLOAD
  !define PAYLOAD "payload"
!endif
!ifndef ICON
  !define ICON "..\resources\icons\appIcon.ico"
!endif
!ifndef REQUESTLEVEL
  !define REQUESTLEVEL admin
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "LiBER"
OutFile "dist\LiBER-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\LiBER"
; No InstallDirRegKey here on purpose. NSIS uses the registry value as $INSTDIR
; when /D is absent, so a stale key from a one-off test install silently
; redirects every later silent install (and the Start Menu shortcut) to a
; directory that may already be deleted. The key is still written for
; information; it just must never decide where the next install goes.
RequestExecutionLevel ${REQUESTLEVEL}
SetCompressor /SOLID lzma

BrandingText "LiBER ${VERSION} — Arthov Labs"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "LiBER"
VIAddVersionKey "CompanyName" "Arthov Labs"
VIAddVersionKey "FileDescription" "LiBER installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT © 2026 June Arthov"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "-NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\launch.ps1$\" -InstallDir $\"$INSTDIR$\""
!define MUI_FINISHPAGE_RUN_TEXT "Launch LiBER now"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── install ────────────────────────────────────────────────────────────────
Section "LiBER" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; the runtime: CLI, daemon, sources, production node_modules, skills.
  ; It must keep its app\ prefix: the shortcuts and launch.ps1 expect
  ; $INSTDIR\app\LiBER.exe, and flattening it here silently breaks them.
  SetOutPath "$INSTDIR\app"
  File /r "${PAYLOAD}\app\*.*"
  ; the optional bundled interpreter (absent when built with -SkipNode). This has
  ; to be a compile-time check: `File` is a compiler instruction, so a runtime
  ; IfFileExists around it would still try to pack a missing directory.
  !if /FileExists "${PAYLOAD}\runtime\node.exe"
    SetOutPath "$INSTDIR\runtime"
    File /r "${PAYLOAD}\runtime\*.*"
  !endif
  ; launcher and uninstaller helpers live next to the app, not inside it
  SetOutPath "$INSTDIR"
  File "${PAYLOAD}\launch.ps1"
  File "${PAYLOAD}\uninstall.ps1"
  File "${PAYLOAD}\stop-daemon.ps1"

  ; Start Menu shortcut: it runs the launcher, which starts the daemon and then
  ; the window. launch.ps1 sets the working directory itself, so no StartIn here.
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\LiBER.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\launch.ps1" -InstallDir "$INSTDIR"' \
    "$INSTDIR\app\LiBER.exe" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Uninstall LiBER.lnk" "$INSTDIR\uninstall.exe"

  ; Files from earlier builds that packed the app at the root instead of app\.
  ; They are stale duplicates: app\ is the real tree, and leaving both means the
  ; next launch can start a second, older copy.
  IfFileExists "$INSTDIR\app\LiBER.exe" 0 noLeftovers
    Delete "$INSTDIR\LiBER.exe"
    Delete "$INSTDIR\package.json"
    Delete "$INSTDIR\liber.yaml"
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\.env.example"
    Delete "$INSTDIR\README.md"
    Delete "$INSTDIR\package-lock.json"
    Delete "$INSTDIR\resources.neu"
    RMDir /r "$INSTDIR\src"
    RMDir /r "$INSTDIR\skills"
    RMDir /r "$INSTDIR\bin"
    RMDir /r "$INSTDIR\node_modules"
  noLeftovers:

  WriteRegStr HKCU "Software\LiBER" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "DisplayName" "LiBER"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "Publisher" "Arthov Labs"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "DisplayIcon" "$INSTDIR\app\LiBER.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER" "NoRepair" 1

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortCut "$DESKTOP\LiBER.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\launch.ps1" -InstallDir "$INSTDIR"' \
    "$INSTDIR\app\LiBER.exe" 0 SW_SHOWNORMAL
SectionEnd

; ── uninstall ──────────────────────────────────────────────────────────────
Section "Uninstall"
  ; stop the daemon first: it holds files inside $INSTDIR
  IfFileExists "$INSTDIR\stop-daemon.ps1" 0 stopDone
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\stop-daemon.ps1"'
    Sleep 800
  stopDone:

  Delete "$SMPROGRAMS\LiBER.lnk"
  Delete "$SMPROGRAMS\Uninstall LiBER.lnk"
  Delete "$DESKTOP\LiBER.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER"
  DeleteRegKey HKCU "Software\LiBER"

  RMDir /r "$INSTDIR"

  ; %LOCALAPPDATA%\LiBER (sessions, memory, vault) is deliberately left alone.
  MessageBox MB_ICONINFORMATION|MB_OK "LiBER has been removed.$\r$\n$\r$\nYour sessions, memory and vault stay in %LOCALAPPDATA%\LiBER — delete that folder if you want them gone too."
SectionEnd
