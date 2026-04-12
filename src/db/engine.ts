/**
 * DuckDB engine — shared connection and query helpers.
 *
 * Uses the duckdb npm package. All queries go through a single
 * in-memory database instance that can read JSONL files natively
 * and attach SQLite databases via the sqlite_scanner extension.
 */

import duckdb from "duckdb"

let _db: duckdb.Database | null = null
let _conn: duckdb.Connection | null = null

function getDb(): duckdb.Database {
  if (!_db) {
    _db = new duckdb.Database(":memory:")
    _conn = null
  }
  return _db
}

function getConn(): duckdb.Connection {
  if (!_conn) {
    _conn = getDb().connect()
  }
  return _conn
}

/** Run a SQL query and return all rows. */
export function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const conn = getConn()
  const db = _db
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, rows: any) => {
      void conn; void db  // prevent GC until callback fires
      if (err) reject(err)
      else resolve((rows ?? []) as T[])
    }
    if (params.length > 0) {
      conn.all(sql, ...params, cb)
    } else {
      conn.all(sql, cb)
    }
  })
}

/** Run a SQL statement (no results expected). */
export function exec(sql: string): Promise<void> {
  const conn = getConn()
  const db = _db
  return new Promise((resolve, reject) => {
    conn.exec(sql, (err: Error | null) => {
      void conn; void db
      if (err) reject(err)
      else resolve()
    })
  })
}

/** Load the sqlite_scanner extension for querying SQLite databases. */
export async function loadSqliteScanner(): Promise<void> {
  await exec("INSTALL sqlite_scanner")
  await exec("LOAD sqlite_scanner")
}

/** Close the database connection. */
export function close(): void {
  _conn = null
  if (_db) {
    _db.close()
    _db = null
  }
}
