function showProgress(window) {
  if(window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  window.show();
  // moveTop changes z-order even when Windows declines an ordinary focus
  // request. The temporary topmost pulse avoids leaving progress windows
  // permanently above every application.
  window.setAlwaysOnTop?.(true);
  window.moveTop?.();
  window.focus();
  window.setAlwaysOnTop?.(false);
}
function closeCancelledProgress(window,download){
  if(!download || download.status==='cancelled'){
    if(!window.isDestroyed())window.close();
    return true;
  }
  return false;
}
module.exports={showProgress,closeCancelledProgress};
