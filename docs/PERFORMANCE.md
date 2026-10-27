# Download performance

| Feature | Implementation |
|---|---|
| Direct seek-and-write, parallel file writes | One pre-sized `data.bin`; every segment writes at its own offset (`core/chunk.mjs`). No part files, no merge step. Resume uses fsync-confirmed `committed` offsets. |
| Worker threads | `core/pool.mjs` + `core/chunk-worker.mjs`: network receive and disk writes run off the main thread (≤4 workers, many transfers each). Falls back to in-thread automatically. |
| Zero-copy finalisation | Finished file is `rename`d into place; across volumes `copyFile` (reflink / `copy_file_range` / `CopyFile`) is used. |
| `Buffer.allocUnsafe` | Recycled write slabs (64 KiB–1 MiB) and 4 MiB merge buffers, never zero-filled. |
| Async, non-blocking I/O | All disk and network I/O is async; `UV_THREADPOOL_SIZE=32` in the desktop app. |
| DNS prefetch + cache | `core/dns.mjs`: prefetch on add/HLS, 5 min fresh + stale-while-revalidate, address round-robin. |
| Connection reuse | Keep-alive agents, `TCP_NODELAY`, TCP keep-alive; HEAD probe connection is reused. |
| HTTP/2 multiplexing | ALPN-negotiated, ≤2 sessions per origin per thread, 8 MiB stream / 64 MiB connection windows. |

Settings (all default on): `directWrite`, `workerThreads`, `http2`. Env `AWESOME_NO_WORKERS=1` disables workers.
Not included: HTTP/3 and BBR (Node has no QUIC; congestion control is an OS setting), socket-to-file splice, `SO_RCVBUF` control.

## Block scheduler, adaptive connections and integrity

- Files that support byte ranges are downloaded as sequential **2–4 MB blocks**. Each block is aggregated in memory
  (`BlockBuffer`, `allocUnsafe`-backed) and written to its final offset by an ordered write queue only after every byte
  was overwritten by received data; incomplete blocks are never written.
- **Adaptive chunk sizing:** fast connections get 4 MB blocks, slow ones 2 MB; the memory budget (Options → Integrity &
  performance) caps the size when many connections are used. Slow connections are aborted mid-block and replaced;
  faster mirrors receive more blocks; the last stragglers are duplicated on idle fast connections.
- **HTTP 429 / 503:** that origin's connection count is halved (never below 1), `Retry-After` is honoured, the origin
  is moved to one multiplexed HTTP/2 session, and connections creep back up while the server stays calm.
- **Integrity:** SHA-256 and MD5 are computed in a worker thread over the contiguous written prefix while downloading.
  A checksum entered by the user must match (mismatch discards the file); a digest announced by the server only warns.
- Files smaller than 4 MB use the part-file layout; a file needs at least 2 MB per connection to use them all.
