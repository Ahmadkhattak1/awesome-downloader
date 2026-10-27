import { parentPort } from 'node:worker_threads';
import { HashSession } from './hash-session.mjs';

// Hashing runs here, off the UI thread: the engine reports how much of the file is complete and this thread
// reads it back from disk and feeds SHA-256 / MD5 while the rest of the download is still in progress.
const sessions = new Map();
parentPort.on('message', async message => {
  const { type, id } = message;
  if (type === 'open') { sessions.set(id, new HashSession(message.file, message.algorithms)); return; }
  const session = sessions.get(id);
  if (!session) { if (type === 'digest') parentPort.postMessage({ id, type: 'error', message: 'Unknown hash session.' }); return; }
  if (type === 'advance') { session.advance(message.upTo); return; }
  if (type === 'close') { sessions.delete(id); return; }
  if (type === 'digest') {
    try { parentPort.postMessage({ id, type: 'digest', digests: await session.digest(message.total) }); }
    catch (error) { parentPort.postMessage({ id, type: 'error', message: error.message }); }
    finally { sessions.delete(id); }
  }
});
