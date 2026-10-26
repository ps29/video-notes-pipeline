; Video Notes installer additions (electron-builder nsis.include).
;
; Adds a page after the install-folder page that lists the tools Video Notes uses, with live
; found / not found status for those it can see on PATH, and a checkbox to open the app's
; setup assistant (Dependencies tab) on first start. The installer itself installs nothing
; else; the choice is left in %APPDATA%\Video Notes\setup-choice.txt for the app to read.

!ifndef BUILD_UNINSTALLER

!include nsDialogs.nsh
!include LogicLib.nsh

Var DepsDialog
Var DepsCheckbox
Var DepsChoice
Var DepsStatus

; Expanded where the pages are defined, after the Modern UI macros (MUI_HEADER_TEXT)
; are available, so the page functions live inside it.
!macro customPageAfterChangeDir
  Page custom DepsPageCreate DepsPageLeave

; $R0 = program name to look for on PATH; sets $DepsStatus to "found" or "not found".
Function DepsFind
  nsExec::ExecToStack 'where.exe $R0'
  Pop $R1 ; exit code
  Pop $R2 ; output (unused)
  ${If} $R1 == 0
    StrCpy $DepsStatus "found"
  ${Else}
    StrCpy $DepsStatus "not found"
  ${EndIf}
FunctionEnd

Function DepsPageCreate
  !insertmacro MUI_HEADER_TEXT "Tools Video Notes uses" "Video Notes works with a few other programs. Here is what this PC has."
  nsDialogs::Create 1018
  Pop $DepsDialog
  ${If} $DepsDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "These are not part of this installer. After installing, the app can check them again and set up what's missing, one tool at a time, only when you click Install."
  Pop $0

  StrCpy $R0 "ffmpeg"
  Call DepsFind
  ${NSD_CreateLabel} 8u 24u 100% 10u "ffmpeg (audio and screenshots, required):  $DepsStatus"
  Pop $0

  StrCpy $R0 "claude"
  Call DepsFind
  ${NSD_CreateLabel} 8u 36u 100% 10u "Claude CLI (default AI for the notes; an API or a local model also works):  $DepsStatus"
  Pop $0

  StrCpy $R0 "pandoc"
  Call DepsFind
  ${NSD_CreateLabel} 8u 48u 100% 10u "pandoc (Word document with screenshots):  $DepsStatus"
  Pop $0

  StrCpy $R0 "winget"
  Call DepsFind
  ${NSD_CreateLabel} 8u 60u 100% 10u "Windows Package Manager (used to install the tools above):  $DepsStatus"
  Pop $0

  ${NSD_CreateLabel} 0 76u 100% 28u "For videos without subtitles you also need Python and Whisper speech-to-text (about 0.5 GB, or a GPU build that installs about 6 GB of build tools). An optional local vision model describes screenshots (about 3 GB)."
  Pop $0

  ${NSD_CreateCheckbox} 0 112u 100% 12u "&Open the setup assistant when Video Notes starts"
  Pop $DepsCheckbox
  ${NSD_Check} $DepsCheckbox

  ${NSD_CreateLabel} 12u 126u 100% 10u "It installs only what you choose, and stays available on the Dependencies tab."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function DepsPageLeave
  ${NSD_GetState} $DepsCheckbox $DepsChoice
FunctionEnd
!macroend

!macro customInstall
  ; Updates skip the page, so there is no choice to record then.
  ${If} $DepsChoice != ""
    CreateDirectory "$APPDATA\${PRODUCT_NAME}"
    FileOpen $0 "$APPDATA\${PRODUCT_NAME}\setup-choice.txt" w
    ${If} $DepsChoice == ${BST_CHECKED}
      FileWrite $0 "open"
    ${Else}
      FileWrite $0 "skip"
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

!endif
