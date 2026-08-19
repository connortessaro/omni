// Stands in for @tauri-apps/plugin-sql. Records every statement and lets a test
// script the rows a select returns, so the real database layer in
// src/lib/database can be exercised in Node without a SQLite build.
//
// State lives on globalThis deliberately. esbuild inlines this file into the
// bundle it builds for the module under test, so the test script's own import
// is a separate module instance. Without a shared store the test would be
// inspecting an array nothing ever writes to.

export interface RecordedStatement {
  sql: string;
  params: unknown[];
}

type SelectHandler = (sql: string, params: unknown[]) => unknown[];

interface StubStore {
  recorded: RecordedStatement[];
  selectHandler: SelectHandler;
}

const STORE_KEY = "__omniSqlStub__";

const store: StubStore = ((globalThis as Record<string, unknown>)[STORE_KEY] ??=
  {
    recorded: [],
    selectHandler: () => [],
  }) as StubStore;

export const recorded = store.recorded;

export const setSelectHandler = (handler: SelectHandler): void => {
  store.selectHandler = handler;
};

export const reset = (): void => {
  store.recorded.length = 0;
  store.selectHandler = () => [];
};

/** Statements whose SQL contains every one of the given fragments. */
export const statementsMatching = (
  ...fragments: string[]
): RecordedStatement[] =>
  store.recorded.filter((statement) =>
    fragments.every((fragment) => statement.sql.includes(fragment))
  );

class StubDatabase {
  static async load(_path: string): Promise<StubDatabase> {
    return new StubDatabase();
  }

  async execute(sql: string, params: unknown[] = []) {
    store.recorded.push({ sql, params });
    return { rowsAffected: 1, lastInsertId: 0 };
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    store.recorded.push({ sql, params });
    return store.selectHandler(sql, params) as T;
  }

  async close() {
    return true;
  }
}

export default StubDatabase;
