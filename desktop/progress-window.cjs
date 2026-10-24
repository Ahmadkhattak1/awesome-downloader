function showProgress(window) {
  if(window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  window.show();window.focus();
}
function closeCancelledProgress(window,download){
  if(!download || download.status==='cancelled'){
    if(!window.isDestroyed())window.close();
    return true;
  }
  return false;
}
module.exports={showProgress,closeCancelledProgress};
