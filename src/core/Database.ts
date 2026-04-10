// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * Database.ts — SQLite database access.
 *
 * Mirrors POPFile::Database. Owns the single SQLite connection and
 * applies the schema from schema.sql on first run. All other modules
 * obtain a reference to this module via database_() and call db() to
 * run queries directly with the @db/sqlite Deno driver.
 *
 * Schema version is tracked in the popfile table; migrations can be
 * appended as numbered upgrade functions.
 */

import { Module, LifecycleResult } from "./Module.ts";
import { join } from "@std/path";
import { Database as SQLite } from "@db/sqlite";

export const SCHEMA_VERSION = 9;

export class Database extends Module {
  #db: SQLite | null = null;

  constructor() {
    super();
    this.name_ = "database";
  }

  override initialize(): LifecycleResult {
    this.config_("db_path", "popfile.db");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    const userDir = this.globalConfig_("user_dir") || "./";
    const dbFile = join(userDir, this.config_("db_path"));
    this.#db = new SQLite(dbFile);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA foreign_keys=ON");
    this.#applySchema();
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#db?.close();
    this.#db = null;
    super.stop();
  }

  /** Returns the raw SQLite handle for use by other modules. */
  db(): SQLite {
    if (!this.#db) throw new Error("Database not started");
    return this.#db;
  }

  // -------------------------------------------------------------------------
  // Schema management
  // -------------------------------------------------------------------------

  #applySchema(): void {
    const db = this.#db!;

    // Create the popfile version table first if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS popfile (
        id      INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0
      )
    `);

    const row = db.prepare("SELECT version FROM popfile LIMIT 1").value<[number]>();
    const currentVersion = row ? row[0] : 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.log_(0, `Applying schema (current=${currentVersion} target=${SCHEMA_VERSION})`);
      this.#createSchema(db);
      db.exec(`DELETE FROM popfile`);
      db.exec(`INSERT INTO popfile (version) VALUES (${SCHEMA_VERSION})`);
    }
  }

  #createSchema(db: SQLite): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS buckets (
        id     INTEGER PRIMARY KEY,
        userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name   TEXT NOT NULL,
        pseudo INTEGER NOT NULL DEFAULT 0,
        UNIQUE(userid, name)
      );

      CREATE TABLE IF NOT EXISTS words (
        id   INTEGER PRIMARY KEY,
        word TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS matrix (
        id       INTEGER PRIMARY KEY,
        wordid   INTEGER NOT NULL REFERENCES words(id)   ON DELETE CASCADE,
        bucketid INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
        times    INTEGER NOT NULL DEFAULT 0,
        UNIQUE(wordid, bucketid)
      );

      CREATE TABLE IF NOT EXISTS user_template (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        def  TEXT NOT NULL DEFAULT '',
        form TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS user_params (
        id     INTEGER PRIMARY KEY,
        userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        utid   INTEGER NOT NULL REFERENCES user_template(id) ON DELETE CASCADE,
        val    TEXT NOT NULL DEFAULT '',
        UNIQUE(userid, utid)
      );

      CREATE TABLE IF NOT EXISTS bucket_template (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        def  TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS bucket_params (
        id       INTEGER PRIMARY KEY,
        bucketid INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
        btid     INTEGER NOT NULL REFERENCES bucket_template(id) ON DELETE CASCADE,
        val      TEXT NOT NULL DEFAULT '',
        UNIQUE(bucketid, btid)
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id      INTEGER PRIMARY KEY,
        userid  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account TEXT NOT NULL,
        UNIQUE(userid, account)
      );

      CREATE TABLE IF NOT EXISTS magnet_types (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS magnets (
        id       INTEGER PRIMARY KEY,
        bucketid INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
        mtid     INTEGER NOT NULL REFERENCES magnet_types(id) ON DELETE CASCADE,
        val      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id             INTEGER PRIMARY KEY,
        userid         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename       TEXT NOT NULL DEFAULT '',
        bucketid       INTEGER REFERENCES buckets(id),
        usedtobe       INTEGER REFERENCES buckets(id),
        magnetid       INTEGER REFERENCES magnets(id),
        date           INTEGER NOT NULL DEFAULT 0,
        from_address   TEXT NOT NULL DEFAULT '',
        to_address     TEXT NOT NULL DEFAULT '',
        subject        TEXT NOT NULL DEFAULT '',
        inserted       INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Seed magnet types
    for (const t of ["from", "to", "subject", "cc"]) {
      db.exec(`INSERT OR IGNORE INTO magnet_types (name) VALUES ('${t}')`);
    }

    // Seed bucket_template defaults
    for (const [name, def] of [["color", "black"], ["quarantine", "0"]]) {
      db.exec(`INSERT OR IGNORE INTO bucket_template (name, def) VALUES ('${name}', '${def}')`);
    }

    // Seed user_template defaults
    for (const [name, def] of [
      ["unclassified_weight", "100"],
      ["wordscores", "0"],
    ]) {
      db.exec(`INSERT OR IGNORE INTO user_template (name, def) VALUES ('${name}', '${def}')`);
    }
  }
}
