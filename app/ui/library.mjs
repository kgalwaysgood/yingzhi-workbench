import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const clone = value => structuredClone(value);

// One atomic document owns managed copies. Generated source files are never edited/deleted.
export class Library {
  constructor(root) {
    this.file = path.join(root, 'data', 'workbench-library', 'records.json');
    this.pending = Promise.resolve();
  }

  async read() {
    try {
      const db = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (db.version !== 1 || !db.records || Array.isArray(db.records)) throw new Error('invalid');
      return db;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: {} };
      throw new Error('资料库无法读取，已停止写入以保护原文件，请查看日志并恢复备份');
    }
  }

  transaction(change) {
    const task = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const lockPath = `${this.file}.lock`;
      let lock;
      try { lock = await fs.open(lockPath, 'wx'); }
      catch (error) {
        if (error.code === 'EEXIST') fail('资料库正被其他窗口写入，请稍后重试；若重启后仍出现，请联系维护人员检查锁文件', 409);
        throw error;
      }
      try {
      const db = await this.read();
      const result = change(db);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(db, null, 2), 'utf8');
        await fs.rename(temp, this.file);
      } finally { await fs.unlink(temp).catch(() => {}); }
      return clone(result);
      } finally { await lock.close(); await fs.unlink(lockPath); }
    });
    this.pending = task.catch(() => {});
    return task;
  }

  async list({ query = '', deleted = false } = {}) {
    await this.pending;
    const db = await this.read();
    const needle = String(query).trim().toLocaleLowerCase();
    return Object.values(db.records).filter(row => Boolean(row.deletedAt) === deleted
      && `${row.title}\n${row.content}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ content, history, ...row }) => ({ ...row, historyCount: history.length, characters: content.length }));
  }

  async get(id, includeDeleted = false) {
    await this.pending;
    const row = (await this.read()).records[id];
    if (!row || (row.deletedAt && !includeDeleted)) fail('资料不存在或已移入回收站', 404);
    return clone(row);
  }

  validate(input) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) fail('标题须为 1 到 200 字');
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 200000) fail('正文须为 1 到 200000 字');
    if (!['pending', 'reviewed'].includes(input.reviewStatus || 'pending')) fail('审核状态无效');
  }

  async add({ title, content, kind = 'note', sourceId = null, sourceUrl = '', reviewStatus = 'pending' }, imported = false) {
    this.validate({ title, content, reviewStatus });
    if (!['note', 'transcript', 'knowledge'].includes(kind)) fail('资料类型无效');
    if (imported && !/^\d+$/.test(String(sourceId))) fail('来源编号无效');
    const id = imported ? `${kind}:${sourceId}` : `note:${randomUUID()}`;
    return this.transaction(db => {
      // Reprocessing must not silently overwrite edits or resurrect deleted resources.
      if (db.records[id]) {
        const existing = db.records[id];
        if (existing.kind === 'knowledge' && !existing.deletedAt && existing.content !== content) {
          existing.latestGenerated = { title: title.trim(), content };
        }
        return existing;
      }
      const now = new Date().toISOString();
      const row = { id, kind, title: title.trim(), content, sourceId, sourceUrl, reviewStatus,
        revision: 1, createdAt: now, updatedAt: now, deletedAt: null, edited: false, history: [] };
      db.records[id] = row;
      return row;
    });
  }

  async change(id, expectedRevision, action, input = {}) {
    if (action === 'edit') this.validate(input);
    if (!['edit', 'delete', 'restore'].includes(action)) fail('操作无效');
    return this.transaction(db => {
      const row = db.records[id];
      if (!row) fail('资料不存在', 404);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== row.revision) fail('资料已被修改，请重新打开后再保存，未覆盖他人修改', 409);
      if (row.deletedAt && action !== 'restore') fail('请先从回收站恢复资料', 409);
      if (!row.deletedAt && action === 'restore') fail('资料不在回收站', 409);
      row.history.push({ revision: row.revision, title: row.title, content: row.content,
        reviewStatus: row.reviewStatus, deletedAt: row.deletedAt, updatedAt: row.updatedAt });
      if (action === 'edit') Object.assign(row, { title: input.title.trim(), content: input.content,
        reviewStatus: input.reviewStatus || 'pending', edited: true });
      if (action === 'edit' && row.kind === 'knowledge' && row.content === row.latestGenerated?.content) {
        row.sourceChanged = false;
        delete row.latestGenerated;
      }
      if (action === 'edit' && row.kind === 'transcript') {
        const derived = db.records[`knowledge:${row.sourceId}`];
        if (derived) {
          derived.history.push({ revision: derived.revision, title: derived.title, content: derived.content,
            reviewStatus: derived.reviewStatus, deletedAt: derived.deletedAt, updatedAt: derived.updatedAt });
          derived.sourceChanged = true;
          derived.reviewStatus = 'pending';
          derived.revision++;
          derived.updatedAt = new Date().toISOString();
        }
      }
      if (action === 'delete') row.deletedAt = new Date().toISOString();
      if (action === 'restore') row.deletedAt = null;
      row.revision++;
      row.updatedAt = new Date().toISOString();
      return row;
    });
  }
}
