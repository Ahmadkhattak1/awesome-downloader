!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include MUI2.nsh
!system '"${NSISDIR}\makensis.exe" /V2 "/DOUTPUT_FILE=${BUILD_RESOURCES_DIR}\browser-setup-helper.exe" "${BUILD_RESOURCES_DIR}\browser-setup-helper.nsi"' = 0

!ifndef BUILD_UNINSTALLER
Var browserSetupCheckbox
Var browserSetupSelected

!macro customPageAfterChangeDir
  Page custom browserSetupPage browserSetupLeave
!macroend

Function browserSetupPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Browser download buttons" "Add the published Awesome Downloader extension."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 42u "Setup can ask Chrome and Edge to add the official extension. Windows will request administrator permission for this step. Your browser will ask you to enable the extension, usually after restarting the browser."
  Pop $0
  ${NSD_CreateCheckbox} 0 55u 100% 22u "Set up Chrome and Edge download buttons"
  Pop $browserSetupCheckbox
  ${NSD_Check} $browserSetupCheckbox
  nsDialogs::Show
FunctionEnd

Function browserSetupLeave
  ${NSD_GetState} $browserSetupCheckbox $browserSetupSelected
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
  ${AndIf} $browserSetupSelected == ${BST_CHECKED}
    InitPluginsDir
    File /oname=$PLUGINSDIR\AwesomeBrowserSetup.exe "${BUILD_RESOURCES_DIR}\browser-setup-helper.exe"
    ClearErrors
    ExecShellWait "runas" "$PLUGINSDIR\AwesomeBrowserSetup.exe" '/owner=$\"$INSTDIR$\"' SW_HIDE $0
    ${If} ${Errors}
      MessageBox MB_OK "The app is installed. Automatic browser setup was not completed. You can install the extension later from Browser integration."
    ${ElseIf} $0 != 0
      WriteRegDWORD SHCTX "${INSTALL_REGISTRY_KEY}" "AutomaticBrowserSetup" 1
      ${If} $0 == 2
        MessageBox MB_OK "The app is installed, but the browser setup helper received an invalid installation path (error 2). Please report this installer error. Manual extension setup is available in Browser integration."
      ${ElseIf} $0 == 1
        MessageBox MB_OK "The app is installed, but Windows denied a browser setup registry operation (error 1). Check your Windows administrator permissions. Manual extension setup is available in Browser integration."
      ${Else}
        MessageBox MB_OK "The app is installed, but browser setup returned error $0. Please report this code. Manual extension setup is available in Browser integration."
      ${EndIf}
    ${Else}
      WriteRegDWORD SHCTX "${INSTALL_REGISTRY_KEY}" "AutomaticBrowserSetup" 1
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegDWORD $0 SHCTX "${INSTALL_REGISTRY_KEY}" "AutomaticBrowserSetup"
    ${If} $0 == 1
      InitPluginsDir
      File /oname=$PLUGINSDIR\AwesomeBrowserSetup.exe "${BUILD_RESOURCES_DIR}\browser-setup-helper.exe"
      ClearErrors
      ExecShellWait "runas" "$PLUGINSDIR\AwesomeBrowserSetup.exe" '/remove /owner=$\"$INSTDIR$\"' SW_HIDE $0
      ${If} ${Errors}
        ${IfNot} ${Silent}
          MessageBox MB_OK "Automatic browser registration could not be removed. Approve the Windows permission prompt when uninstalling to clean it up."
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
