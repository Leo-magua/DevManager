/**
 * Atomic JSON file writer with a per-path mutex.
 *
 * Background: many call sites (src/routes/features.js, src/routes/projects.js,
 * src/routes/agent-direct.js, src/core/task-queue.js, src/core/state-sync.js,
 * src/core/project-scanner.js, ...) write to per-project dev_state.json
 * files using the read-modify-write pattern. Because Express handlers run
 * concurrently, two simultaneous writes can race and silently lose updates,
 * and a crash mid-write can leave the JSON file truncated.
 *
 * This helper provides:
 *
 *   1. A per-absolute-path async mutex so writes to the same file are
 *      serialized within a single Node.js process.
 *   2. An atomic write: serialize → write to a tempfile in the same
 *      directory → fsync → rename over the target. POSIX rename is atomic
 *      within a filesystem, so readers always see either the old or the
 *      new file, never a half-written one.
 *
 * Usage:
 *
 *   const { writeJsonAtomic, withFileLock } = require('./atomic-write');
 *   await writeJsonAtomic(devStatePath, devState);
 *
 *   // or, for read-modify-write on the same file:
 *   await withFileLock(devStatePath, async () => {
 *     const cur = JSON.parse(await fs.readFile(devStatePath, 'utf-8'));
 *     cur.foo = 'bar';
 *     await writeJsonAtomic(devStatePath, cur);
 *   });
 *
 * Note: this is intra-process only. If multiple Node processes write the
 * same file concurrently the atomic rename still prevents torn writes,
 * but lost-update races between processes are out of scope (DevManager
 * is single-process today).
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const locks = new Map(); // absolutePath -> Promise (chain tail)

/**
 * Run `fn` while holding an exclusive lock keyed on the canonical path.
 * Locks are FIFO: callers are served in arrival order.
 */
async function withFileLock(filePath, fn) {
  const key = path.resolve(filePath);
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  locks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up the map entry once it has drained, so we don't leak keys
    // for files that are written once and never again.
    if (locks.get(key) === prev.then(() => next)) {
      // Best-effort cleanup; safe even if a new waiter raced in: the new
      // tail will just reset the entry on its own write.
    }
    queueMicrotask(() => {
      const tail = locks.get(key);
      if (tail) {
        tail.then(() => {
          if (locks.get(key) === tail) locks.delete(key);
        }).catch(() => {});
      }
    });
  }
}

/**
 * Atomically write JSON to `filePath`. Stringifies with `space=2` to match
 * the existing on-disk format. Acquires the per-path lock automatically.
 */
async function writeJsonAtomic(filePath, data, { space = 2 } = {}) {
  return withFileLock(filePath, async () => {
    const target = path.resolve(filePath);
    const dir = path.dirname(target);
    const base = path.basename(target);
    // Random suffix avoids collisions if the helper is somehow nested.
    const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const payload = JSON.stringify(data, null, space);

    let fh;
    try {
      fh = await fs.open(tmp, 'w', 0o644);
      await fh.writeFile(payload, 'utf-8');
      // fsync so the rename below makes a durable file, not just a name
      // pointing at unwritten data.
      try { await fh.sync(); } catch { /* tmpfs etc. may not support fsync */ }
    } finally {
      if (fh) {
        try { await fh.close(); } catch { /* ignore */ }
      }
    }

    try {
      await fs.rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup of the tempfile if rename failed.
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  });
}

module.exports = { writeJsonAtomic, withFileLock };
