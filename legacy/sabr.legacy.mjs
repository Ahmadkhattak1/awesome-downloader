// Replaces core/sabr.mjs in the Windows 7/8/8.1 build. YouTube SABR capture needs a modern
// runtime (global fetch/streams), so it is reported as unavailable instead of crashing startup.
const unavailable = () => new Error('YouTube capture needs the standard build on Windows 10 or newer. Direct files, HLS and other sites still work.');
export function normalizeSabrSession() { throw unavailable(); }
export async function downloadSabr() { throw unavailable(); }
