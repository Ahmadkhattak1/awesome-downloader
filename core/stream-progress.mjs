export function streamProgress(segments) {
  const complete=segments.filter(s=>s.done), downloaded=segments.reduce((n,s)=>n+s.downloaded,0);
  const completedBytes=complete.reduce((n,s)=>n+s.downloaded,0);
  return {completed:complete.length,total:segments.length,estimatedBytes:complete.length>=2&&complete.length<segments.length?Math.max(downloaded,completedBytes/complete.length*segments.length):null};
}
