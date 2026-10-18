// A small stand-in for Cloudflare D1 on Node's built-in SQLite, for tests and local runs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { const r = stmt.get(...args); return r ? { ...r } : null; },
        async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        async all() { return { results: stmt.all(...args).map(r => ({ ...r })) }; },
      };
      return api;
    },
  };
}
