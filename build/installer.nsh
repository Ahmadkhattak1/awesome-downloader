; Custom NSIS hooks for electron-builder (per-user install).

; On a real uninstall (not an in-place update) remove the per-user browser native-messaging registrations that the
; app created. Without this the keys keep pointing at a deleted native-host.exe and Chrome/Edge log errors forever.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.awesome.downloader"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.awesome.downloader"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\com.awesome.downloader"
    RMDir /r "$PROFILE\.awesome-downloader\BrowserIntegration"
    RMDir /r "$PROFILE\.awesome-downloader\NativeMessaging"
  ${endIf}
!macroend
