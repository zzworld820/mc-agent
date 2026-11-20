import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { explainDeath } from './survival-deaths.mjs';

// Death logging holds this exact object. Replacing it on each heartbeat loses
// later counter updates and leaves death reports with a stale elapsed-day value.
export function updateRunStatus(status, patch) {
  Object.assign(status, patch);
  return status;
}

export async function reconcileRunDeaths(status, eventsFile) {
  const ids = new Set();
  let latest;
  const input = createReadStream(eventsFile, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"type":"DEATH"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'DEATH' || !entry.id) continue;
      ids.add(entry.id);
      latest = entry;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  status.deaths = Math.max(status.deaths || 0, ids.size);
  if (latest) status.lastDeathSummary = { number: status.deaths, time: latest.time,
    reason: explainDeath(latest.serverMessage) };
  return ids.size;
}
