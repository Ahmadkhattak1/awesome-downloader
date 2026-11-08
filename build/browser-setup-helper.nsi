Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
Name "Awesome Downloader browser setup"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel admin
SilentInstall silent
!define EXTENSION_ID "dnolinbkicmedadaigcedkmndcpahmml"
!define UPDATE_URL "https://clients2.google.com/service/update2/crx"
!define OWNERS "Software\AwesomeDownloader\BrowserSetupOwners"
Var owner

!macro registerBrowser ROOT
  EnumRegValue $1 HKLM "${ROOT}\${EXTENSION_ID}" 0
  ${If} $1 == ""
    ClearErrors
    WriteRegStr HKLM "${ROOT}\${EXTENSION_ID}" "update_url" "${UPDATE_URL}"
    ${If} ${Errors}
      SetErrorLevel 1
      Quit
    ${EndIf}
    WriteRegDWORD HKLM "${ROOT}\${EXTENSION_ID}" "AwesomeDownloaderOwned" 1
  ${EndIf}
!macroend

!macro unregisterBrowser ROOT
  ReadRegDWORD $1 HKLM "${ROOT}\${EXTENSION_ID}" "AwesomeDownloaderOwned"
  ReadRegStr $2 HKLM "${ROOT}\${EXTENSION_ID}" "update_url"
  ${If} $1 == 1
  ${AndIf} $2 == "${UPDATE_URL}"
    DeleteRegValue HKLM "${ROOT}\${EXTENSION_ID}" "update_url"
    DeleteRegValue HKLM "${ROOT}\${EXTENSION_ID}" "AwesomeDownloaderOwned"
    DeleteRegKey /ifempty HKLM "${ROOT}\${EXTENSION_ID}"
  ${EndIf}
!macroend

Section
  SetRegView 32
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/owner=" $owner
  ${If} ${Errors}
  ${OrIf} $owner == ""
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/remove" $3
  ${IfNot} ${Errors}
    DeleteRegValue HKLM "${OWNERS}" "$owner"
    EnumRegValue $1 HKLM "${OWNERS}" 0
    ${If} $1 == ""
      !insertmacro unregisterBrowser "Software\Google\Chrome\Extensions"
      !insertmacro unregisterBrowser "Software\Microsoft\Edge\Extensions"
      DeleteRegKey /ifempty HKLM "${OWNERS}"
    ${EndIf}
  ${Else}
    ClearErrors
    WriteRegDWORD HKLM "${OWNERS}" "$owner" 1
    ${If} ${Errors}
      SetErrorLevel 1
      Quit
    ${EndIf}
    !insertmacro registerBrowser "Software\Google\Chrome\Extensions"
    !insertmacro registerBrowser "Software\Microsoft\Edge\Extensions"
  ${EndIf}
  SetErrorLevel 0
SectionEnd
