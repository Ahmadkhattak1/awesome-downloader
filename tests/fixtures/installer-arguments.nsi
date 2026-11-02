Unicode true
!include FileFunc.nsh
!include LogicLib.nsh
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
SilentInstall silent
Section
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/owner=" $1
  ${If} ${Errors}
  ${OrIf} $1 != "C:\Program Files\Awesome Downloader"
    SetErrorLevel 2
  ${Else}
    SetErrorLevel 0
  ${EndIf}
SectionEnd
