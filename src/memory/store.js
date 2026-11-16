// 数据库层只供管理层调用，不向大模型暴露原始查询或凭证。
import { MongoClient } from 'mongodb';

export class MongoMemoryStore {
  constructor({ mongoUri, database }) {
    this.client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000, maxPoolSize: 5 });
    this.database = database;
    this.connection = null;
    this.closed = false;
  }

  async ready() {
    if (this.closed) throw new Error('长期记忆连接已关闭');
    if (!this.connection) {
      this.connection = (async () => {
        await this.client.connect();
        const db = this.client.db(this.database);
        await db.collection('memories').createIndex({ worldId: 1, dimension: 1, kind: 1, updatedAt: -1 });
        await db.collection('memories').createIndex({ scope: 1, authorAgentId: 1, teamId: 1 });
        return db;
      })().catch(() => {
        this.connection = null;
        throw new Error('MongoDB 长期记忆不可用，请检查服务、连接和索引权限');
      });
    }
    return this.connection;
  }

  async collection(name) { return (await this.ready()).collection(name); }

  async close() {
    this.closed = true;
    await this.connection?.catch(() => {});
    await this.client.close();
  }
}
