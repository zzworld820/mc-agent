import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';

const directory = new URL('../../data/projects/', import.meta.url);
const pending = new Map();

export function projectStore(partition, root = directory) {
  const key = createHash('sha256').update(JSON.stringify(partition)).digest('hex');
  const file = new URL(`${key}.json`, root);

  async function read() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.history)) throw new Error('工程存档版本不支持');
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, active: null, history: [] };
    }
  }

  function update(change) {
    const work = (pending.get(file.href) || Promise.resolve()).catch(() => {}).then(async () => {
      const data = await read();
      const result = change(data);
      if (result === false) return null;
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temp = new URL(`${key}.${randomUUID()}.tmp`, root);
      try {
        await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
      return result;
    });
    pending.set(file.href, work);
    return work.finally(() => { if (pending.get(file.href) === work) pending.delete(file.href); });
  }

  return {
    async read() {
      await pending.get(file.href)?.catch(() => {});
      return read();
    },
    create(project) {
      return update(data => {
        if (data.active) throw new Error('此世界已有工程，可查询状态或恢复现有工程');
        data.active = project;
        return project;
      });
    },
    update(id, change) {
      return update(data => {
        if (data.active?.id !== id) return false;
        const project = data.active;
        if (change(project) === false) return false;
        project.updatedAt = Date.now();
        if (['complete', 'cancelled'].includes(project.status)) {
          data.history.push(project);
          data.active = null;
        }
        return project;
      });
    },
  };
}
