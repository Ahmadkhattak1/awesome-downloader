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
