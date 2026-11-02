Unicode true
!include "${PROJECT_ROOT}\build\shell-exec-result.nsh"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
SilentInstall silent
Section
  ; A pre-existing UI value must never be mistaken for an exit status.
  StrCpy $0 "0x00070FD8"
  StrCpy $1 123
  !ifdef LEGACY_LAUNCH
    StrCpy $1 0
    ExecShellWait "open" "${CHILD_FILE}" '${CHILD_ARGUMENTS}' SW_HIDE $0
  !else
    !insertmacro AwesomeShellExecResult "open" "${CHILD_FILE}" '${CHILD_ARGUMENTS}' $0 $1
  !endif
  ${If} $1 != 0
    SetErrorLevel 99
  ${Else}
    SetErrorLevel $0
  ${EndIf}
SectionEnd
