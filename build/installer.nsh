; Custom NSIS hooks for electron-builder (per-user install).

; On a real uninstall (not an in-place update) remove the per-user browser native-messaging registry keys. The shared
; ~/.awesome-downloader folders (extension copy, connector manifests) are deliberately left alone: the regular and the
; Legacy build share them, and deleting them broke the other build's browser connection.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.awesome.downloader"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.awesome.downloader"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\com.awesome.downloader"
  ${endIf}
!macroend

; The app hides to the system tray when its window is closed, so the installer's polite close request never ends the
; process and setup stops with "cannot be closed. Please close it manually". End the running app (and its helper
; processes) up front. Downloads resume afterwards: progress is checkpointed every two seconds.
!macro awesomeStopApp
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1500
!macroend
!macro customInit
  !insertmacro awesomeStopApp
!macroend
!macro customUnInit
  !insertmacro awesomeStopApp
!macroend
!macro customCheckAppRunning
  !insertmacro awesomeStopApp
!macroend

; Hide the "<product> <version>" branding text at the bottom of the installer and uninstaller windows.
!macro customHeader
  BrandingText " "
!macroend
