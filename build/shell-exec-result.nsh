!ifndef AWESOME_SHELL_EXEC_RESULT
!define AWESOME_SHELL_EXEC_RESULT
!include LogicLib.nsh

; ExecShellWait does not return a process exit code. Explicitly keep the
; ShellExecuteEx process handle, wait, read its exit status, and close it.
; launchError is separate from exitCode: a cancelled UAC prompt is not a
; helper failure. Preserve callers' registers (apart from the two outputs).
!macro AwesomeShellExecResult verb executable arguments exitCode launchError
  System::Store S
  StrCpy $2 0
  StrCpy $3 0
  !if ${NSIS_PTR_SIZE} > 4
    !define AWESOME_SHELL_INFO_SIZE 112
  !else
    !define AWESOME_SHELL_INFO_SIZE 60
  !endif
  System::Call '*(&i${AWESOME_SHELL_INFO_SIZE})p.r0'
  ; Keep the process handle and suppress shell error dialogs. UAC consent
  ; still appears for runas; the installer handles launch errors itself.
  System::Call '*$0(i ${AWESOME_SHELL_INFO_SIZE},i 0x440,p $HWNDPARENT,t "${verb}",t $\'${executable}$\',t $\'${arguments}$\',p 0,i 0)'
  System::Call 'shell32::ShellExecuteExW(p r0)i.r1 ?e'
  Pop $3
  ${If} $1 != 0
    System::Call '*$0(i,i,p,p,p,p,p,i,p,p,p,p,i,p,p.r1)'
    ${If} $1 != 0
      System::Call 'kernel32::WaitForSingleObject(p r1,i -1)i.r3'
      ${If} $3 == 0
        System::Call 'kernel32::GetExitCodeProcess(p r1,*i.r2)i.r3'
        ${If} $3 != 0
          StrCpy $3 0
        ${Else}
          System::Call 'kernel32::GetLastError()i.r3'
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r1)'
    ${Else}
      StrCpy $3 6 ; ERROR_INVALID_HANDLE: no child process to inspect
    ${EndIf}
  ${EndIf}
  System::Free $0
  Push $2
  Push $3
  System::Store L
  Pop ${launchError}
  Pop ${exitCode}
  !undef AWESOME_SHELL_INFO_SIZE
!macroend
!endif
