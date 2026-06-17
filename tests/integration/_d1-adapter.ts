// tests/integration/_d1-adapter.ts
//
// Adapter that exposes better-sqlite3 as a D1Database-shaped binding. The
// handlers under test call .prepare().bind().run()/first()/all() and
// DB.batch([...]) — those are the surfaces this adapter mirrors. It's not
// pixel-perfect with D1's metadata fields, but it matches what the handlers
// READ from results, which is what regressions hinge on.
//
// Batch atomicity: better-sqlite3's db.transaction() provides real ACID
// rollback. Throwing inside the transaction reverts all statements. This is
// the same guarantee D1's batch() makes (per Cloudflare docs), so the B4
// regression tests against this adapter exercise the same property as
// production.

import BetterSqlite3 from 'better-sqlite3';

type DB = BetterSqlite3.Database;

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number; duration: number };
}

interface D1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

class PreparedStatement {
  private params: unknown[] = [];
  // Reference back to the parent adapter so .run() can bump the
  // adapter-level write-call counter used by B4's forensic test.
  constructor(private readonly db: DB, private readonly sql: string, private readonly parent?: D1Adapter) {}

  bind(...values: unknown[]): PreparedStatement {
    const next = new PreparedStatement(this.db, this.sql, this.parent);
    next.params = values;
    return next;
  }

  async run(): Promise<{ success: boolean; meta: D1Meta }> {
    if (this.parent && this.isMutation()) this.parent.writeRuns++;
    const start = Date.now();
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: Date.now() - start,
      },
    };
  }

  /** Heuristic: any INSERT/UPDATE/DELETE counts as a write. */
  private isMutation(): boolean {
    const head = this.sql.trim().slice(0, 6).toUpperCase();
    return head.startsWith('INSERT') || head.startsWith('UPDATE') || head.startsWith('DELETE');
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params);
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const start = Date.now();
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return {
      results: rows,
      success: true,
      meta: { changes: 0, last_row_id: 0, duration: Date.now() - start },
    };
  }

  /** Internal helper for batch(): run the prepared SQL with bound params. */
  _executeInBatch(): D1Meta {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      changes: info.changes,
      last_row_id: Number(info.lastInsertRowid),
      duration: 0,
    };
  }
}

export class D1Adapter {
  // Public so test setup can run synchronous migration exec; production
  // handlers only see the D1-shaped surface below.
  // batchCalls + writeRuns track method invocations so the B4 test can
  // verify the response handler uses DB.batch() rather than independent
  // prepare().run() calls for its three writes.
  public batchCalls = 0;
  public writeRuns = 0;
  constructor(public readonly db: DB) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql, this);
  }

  /**
   * Atomic batch: all statements run inside a single SQLite transaction.
   * Any throw rolls back all writes — mirrors D1's batch() guarantee.
   * This is the property B4 depends on.
   */
  async batch<T = unknown>(stmts: PreparedStatement[]): Promise<Array<{ success: boolean; meta: D1Meta; results: T[] }>> {
    this.batchCalls++;
    const results: Array<{ success: boolean; meta: D1Meta; results: T[] }> = [];
    const txn = this.db.transaction((items: PreparedStatement[]) => {
      for (const stmt of items) {
        const meta = stmt._executeInBatch();
        results.push({ success: true, meta, results: [] });
      }
    });
    txn(stmts);
    return results;
  }

  /** Reset call counters between test phases. */
  resetCounters(): void {
    this.batchCalls = 0;
    this.writeRuns = 0;
  }

  /**
   * Multi-statement SQL execution. Used by migration application — the
   * handlers don't call exec() directly in this codebase.
   */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const start = Date.now();
    this.db.exec(sql);
    return { count: 0, duration: Date.now() - start };
  }
}

/**
 * Create an in-memory better-sqlite3 DB wrapped as a D1Adapter. Pragma WAL is
 * irrelevant for :memory: but we enable foreign_keys to match real D1 behaviour.
 */
export function createD1Test(): { adapter: D1Adapter; db: DB } {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  return { adapter: new D1Adapter(db), db };
}
