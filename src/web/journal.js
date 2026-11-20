import { appendFile, mkdir, open } from 'node:fs/promises';

const LIMIT = 80;
const RECENT_BYTES = 256 * 1024;

export function createAgentJournal(id, directory = new URL('../../data/web/', import.meta.url), redact = value => value) {
  const file = new URL(`${id}-incidents.jsonl`, directory);
  const rows = [];
  let failure = false;
  let writes = (async () => {
    let handle;
    try {
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      const bytes = Buffer.alloc(Math.min(size, RECENT_BYTES));
      await handle.read(bytes, 0, bytes.length, size - bytes.length);
      const lines = bytes.toString('utf8').split('\n');
      if (size > bytes.length) lines.shift();
      for (const line of lines.slice(-LIMIT - 1)) {
        try { rows.push(JSON.parse(line)); } catch { /* partial or old record */ }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') failure = true;
    } finally { await handle?.close(); }
  })();
  return {
    record(event) {
      const row = redact({ at: new Date().toISOString(), ...event });
      writes = writes.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendFile(file, JSON.stringify(row) + '\n', { mode: 0o600 });
        rows.push(row);
        if (rows.length > LIMIT) rows.splice(0, rows.length - LIMIT);
      }).catch(() => { failure = true; });
      return writes;
    },
    snapshot: () => ({ entries: rows.slice().reverse(), writeError: failure }),
    flush: () => writes,
  };
}
