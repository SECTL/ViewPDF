!macro NSIS_HOOK_PREINSTALL
  FileOpen $0 "$TEMP\ViewPDF-upgrading" w
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$TEMP\ViewPDF-upgrading"
!macroend
