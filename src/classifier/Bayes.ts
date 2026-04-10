/**
 * Bayes.ts — Naive Bayes email classifier.
 *
 * Mirrors Classifier::Bayes. Classifies email messages into user-defined
 * buckets (folders) using a log-probability Naive Bayes model stored in
 * SQLite. Supports:
 *
 *   - Multiple users with isolated bucket sets
 *   - Magnets — regex/string rules that override Bayes (hard rules)
 *   - Session keys for API access control
 *   - Training (add_message_to_bucket) and reclassification
 *   - Score computation and normalization
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { MailParser, ParseResult } from "./MailParser.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  /** Winning bucket name, or "unclassified" */
  bucket: string;
  /** Normalized probability per bucket (0-1, sums to ~1) */
  scores: Map<string, number>;
  /** Whether a magnet triggered the result */
  magnetUsed: boolean;
}

export interface HistoryRow {
  id: number;
  filename: string;
  date: number;
  fromAddress: string;
  subject: string;
  bucket: string;
  usedtobe: string | null;
  magnetUsed: boolean;
}

export interface BucketStat {
  name: string;
  color: string;
  wordCount: number;
  classifiedCount: number;
}

export interface Stats {
  totalClassified: number;
  totalRetrained: number;
  magnetHits: number;
  totalWords: number;
  buckets: BucketStat[];
}

export interface WordScore {
  word: string;
  freq: number;
  /** P(word | bucket) for each bucket */
  bucketProbs: Map<string, number>;
  /** Bucket with the highest probability for this word */
  topBucket: string;
}

export interface ClassifyWithWordScoresResult extends ClassifyResult {
  wordScores: WordScore[];
}

interface Bucket {
  id: number;
  name: string;
  pseudo: boolean;
}

// Internal extended result — carries the matched magnet ID for history storage
interface ClassifyResultInternal extends ClassifyResult {
  magnetId: number | null;
}

interface MagnetRow {
  id: number;
  type: string;   // "from" | "to" | "subject" | "cc"
  val: string;
  bucketName: string;
}

// ---------------------------------------------------------------------------
// Classifier module
// ---------------------------------------------------------------------------

export class Bayes extends Module {
  #parser = new MailParser();

  // Per-user pre-computed constants (updated when training changes)
  #notLikely: Map<number, number> = new Map();      // userid → log(1/totalWords)
  #bucketStart: Map<number, Map<string, number>> = new Map(); // userid → bucket → log(prior)

  // Session management
  #sessions: Map<string, { userId: number; expires: number }> = new Map();
  #lastSweep = 0;

  constructor() {
    super();
    this.name_ = "classifier";
  }

  override initialize(): LifecycleResult {
    this.config_("unclassified_weight", "100");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    this.#updateConstants();
    this.mqRegister_("TICKD", this);
    return LifecycleResult.Ok;
  }

  /** Sweep expired sessions on the hourly TICKD tick. */
  override deliver(type: string): void {
    if (type === "TICKD") this.#releaseExpiredSessions();
  }

  override service(): boolean {
    // Sweep at most once per minute — lazy eviction in #validSession handles
    // the common case; this prevents unbounded accumulation of stale keys.
    const now = Date.now();
    if (now - this.#lastSweep >= 60_000) {
      this.#releaseExpiredSessions();
      this.#lastSweep = now;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  getSessionKey(username: string, password: string): string | null {
    const db = this.db_();
    const row = db.prepare(
      "SELECT u.id FROM users u JOIN accounts a ON a.userid=u.id WHERE u.name=? AND u.password=?"
    ).value<[number]>(username, password);
    if (!row) return null;
    const userId = row[0];
    const key = this.#generateSessionKey();
    const timeout = parseInt(this.globalConfig_("session_timeout"), 10) * 1000;
    this.#sessions.set(key, { userId, expires: Date.now() + timeout });
    return key;
  }

  /**
   * Authenticate directly against the users table (no accounts JOIN).
   * Returns a session key on success, null on failure.
   * Transparently migrates legacy plaintext passwords to PBKDF2 on successful login.
   */
  async loginUser(username: string, password: string): Promise<string | null> {
    const db = this.db_();
    const row = db.prepare(
      "SELECT id, password FROM users WHERE name=?"
    ).value<[number, string]>(username);
    if (!row) return null;
    const [userId, stored] = row;

    const ok = await this.#verifyPassword(password, stored);
    if (!ok) return null;

    // Migrate plaintext password to PBKDF2 on first successful login
    if (!stored.startsWith("pbkdf2:")) {
      const hashed = await this.#hashPassword(password);
      db.exec("UPDATE users SET password=? WHERE id=?", hashed, userId);
    }

    const key = this.#generateSessionKey();
    const timeout = parseInt(this.globalConfig_("session_timeout"), 10) * 1000;
    this.#sessions.set(key, { userId, expires: Date.now() + timeout });
    return key;
  }

  /** Returns true if the session belongs to the admin user (id=1). */
  isAdmin(sessionKey: string): boolean {
    const userId = this.#validSession(sessionKey);
    return userId === 1;
  }

  /** Returns the username for the session, or null if invalid. */
  getUsername(sessionKey: string): string | null {
    const userId = this.#validSession(sessionKey);
    if (userId === null) return null;
    const row = this.db_().prepare("SELECT name FROM users WHERE id=?").value<[string]>(userId);
    return row?.[0] ?? null;
  }

  /** List all users (admin only). */
  listUsers(adminSession: string): Array<{ name: string; isAdmin: boolean }> {
    if (!this.isAdmin(adminSession)) throw new Error("Admin access required");
    const rows = this.db_().prepare(
      "SELECT id, name FROM users ORDER BY id"
    ).values<[number, string]>();
    return rows.map(([id, name]) => ({ name, isAdmin: id === 1 }));
  }

  /** Create a new user (admin only). */
  async createUserAccount(adminSession: string, username: string, password: string): Promise<void> {
    if (!this.isAdmin(adminSession)) throw new Error("Admin access required");
    const hashed = await this.#hashPassword(password);
    this.db_().exec("INSERT INTO users (name, password) VALUES (?,?)", username, hashed);
  }

  /** Delete a user (admin only; cannot delete admin). */
  deleteUserAccount(adminSession: string, username: string): void {
    if (!this.isAdmin(adminSession)) throw new Error("Admin access required");
    if (username === "admin") throw new Error("Cannot delete admin user");
    this.db_().exec("DELETE FROM users WHERE name=? AND id != 1", username);
  }

  /** Change a user's own password. */
  async setPassword(sessionKey: string, newPassword: string): Promise<void> {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const hashed = await this.#hashPassword(newPassword);
    this.db_().exec("UPDATE users SET password=? WHERE id=?", hashed, userId);
  }

  getAdministratorSessionKey(): string {
    // Single-user mode: create/return admin session without auth
    const db = this.db_();
    let row = db.prepare("SELECT id FROM users WHERE name='admin' LIMIT 1").value<[number]>();
    if (!row) {
      db.exec("INSERT OR IGNORE INTO users (name, password) VALUES ('admin','')");
      row = db.prepare("SELECT id FROM users WHERE name='admin' LIMIT 1").value<[number]>()!;
    }
    const userId = row![0];
    const key = this.#generateSessionKey();
    this.#sessions.set(key, { userId, expires: Infinity });
    return key;
  }

  releaseSessionKey(key: string): void {
    this.#sessions.delete(key);
  }

  /** Returns true if the user's current stored password is a hash of the empty string. */
  async isDefaultPassword(sessionKey: string): Promise<boolean> {
    const userId = this.#validSession(sessionKey);
    if (userId === null) return false;
    const row = this.db_().prepare("SELECT password FROM users WHERE id=?").value<[string]>(userId);
    if (!row) return false;
    return await this.#verifyPassword("", row[0]);
  }

  #validSession(key: string): number | null {
    const s = this.#sessions.get(key);
    if (!s) return null;
    if (Date.now() > s.expires) { this.#sessions.delete(key); return null; }
    return s.userId;
  }

  #releaseExpiredSessions(): void {
    const now = Date.now();
    for (const [key, s] of this.#sessions) {
      if (now > s.expires) this.#sessions.delete(key);
    }
  }

  #generateSessionKey(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async #hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
      key, 256
    );
    const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    return `pbkdf2:100000:${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
  }

  async #verifyPassword(password: string, stored: string): Promise<boolean> {
    if (!stored.startsWith("pbkdf2:")) return password === stored;
    const parts = stored.split(":");
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = new Uint8Array(parts[2].match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key, 256
    );
    const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex === parts[3];
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  /**
   * Classify a message file. Returns the winning bucket name (or
   * "unclassified") along with per-bucket probability scores.
   */
  classify(sessionKey: string, filePath: string): ClassifyResult {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");

    const parsed = this.#parser.parseFile(filePath);
    const result = this.classifyParsed(userId, parsed);
    this.#writeHistory(userId, filePath, parsed, result);
    return result;
  }

  getHistory(
    sessionKey: string,
    opts: { limit?: number; offset?: number; bucket?: string; search?: string } = {},
  ): HistoryRow[] {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const { limit = 25, offset = 0, bucket, search } = opts;
    const db = this.db_();
    const filters: string[] = ["h.userid = ?"];
    const params: (string | number)[] = [userId];
    if (bucket) {
      filters.push("COALESCE(b.name, 'unclassified') = ?");
      params.push(bucket);
    }
    if (search) {
      filters.push("(h.subject LIKE ? OR h.from_address LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    const where = filters.join(" AND ");
    const rows = db.prepare(`
      SELECT h.id, h.filename, h.date, h.from_address, h.subject,
             COALESCE(b.name, 'unclassified') AS bucket,
             ub.name AS usedtobe,
             CASE WHEN h.magnetid IS NOT NULL THEN 1 ELSE 0 END AS magnet_used
      FROM history h
      LEFT JOIN buckets b  ON h.bucketid = b.id
      LEFT JOIN buckets ub ON h.usedtobe = ub.id
      WHERE ${where}
      ORDER BY h.date DESC
      LIMIT ? OFFSET ?
    `).values<[number, string, number, string, string, string, string | null, number]>(...params, limit, offset);
    return rows.map(([id, filename, date, fromAddress, subject, bucket, usedtobe, magnetUsed]) => ({
      id, filename, date, fromAddress, subject, bucket,
      usedtobe: usedtobe ?? null,
      magnetUsed: magnetUsed === 1,
    }));
  }

  getHistoryCount(
    sessionKey: string,
    opts: { bucket?: string; search?: string } = {},
  ): number {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const { bucket, search } = opts;
    const db = this.db_();
    const filters: string[] = ["h.userid = ?"];
    const params: (string | number)[] = [userId];
    if (bucket) {
      filters.push("COALESCE(b.name, 'unclassified') = ?");
      params.push(bucket);
    }
    if (search) {
      filters.push("(h.subject LIKE ? OR h.from_address LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    const where = filters.join(" AND ");
    const row = db.prepare(`
      SELECT COUNT(*) FROM history h
      LEFT JOIN buckets b ON h.bucketid = b.id
      WHERE ${where}
    `).value<[number]>(...params);
    return row ? row[0] : 0;
  }

  retrainHistory(sessionKey: string, historyId: number, newBucket: string): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();

    const row = db.prepare(
      "SELECT filename, bucketid FROM history WHERE id=? AND userid=?"
    ).value<[string, number | null]>(historyId, userId);
    if (!row) throw new Error("History entry not found");

    const [filename, oldBucketId] = row;
    const newBucketRow = this.#getBucketByName(userId, newBucket);
    if (!newBucketRow) throw new Error(`Unknown bucket: ${newBucket}`);

    // Record the correction
    db.exec(
      "UPDATE history SET usedtobe=bucketid, bucketid=? WHERE id=?",
      newBucketRow.id, historyId
    );

    // Train the message into the new bucket
    const parsed = this.#parser.parseFile(filename);
    this.trainMessage(sessionKey, newBucket, parsed);

    // If it had a previous bucket, untrain from it
    if (oldBucketId !== null) {
      const oldBucket = db.prepare("SELECT name FROM buckets WHERE id=?").value<[string]>(oldBucketId);
      if (oldBucket) {
        this.#untrainMessage(userId, oldBucket[0], parsed);
      }
    }
  }

  /** Classify an already-parsed message via session key (no file path required). */
  classifyMessage(sessionKey: string, parsed: ParseResult): ClassifyResult {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    return this.classifyParsed(userId, parsed);
  }

  /**
   * Classify a file and return per-word probability scores alongside the
   * normal result. Words are sorted by discriminativeness (max−min
   * probability across buckets, weighted by frequency) and the top `topN`
   * are returned.  History is written exactly as with classify().
   */
  classifyWithWordScores(
    sessionKey: string,
    filePath: string,
    topN = 20,
  ): ClassifyWithWordScoresResult {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");

    const parsed = this.#parser.parseFile(filePath);
    const result = this.classifyParsed(userId, parsed);
    this.#writeHistory(userId, filePath, parsed, result);

    const wordList = [...parsed.words.keys()];
    if (wordList.length === 0) return { ...result, wordScores: [] };

    const db = this.db_();
    const buckets = this.#getBuckets(userId).filter((b) => !b.pseudo);
    if (buckets.length < 2) return { ...result, wordScores: [] };

    const bucketTotalWords = this.#getBucketWordCounts(userId);

    // Resolve word→id for words we know about
    const ph = wordList.map(() => "?").join(",");
    const wordRows = db.prepare(
      `SELECT id, word FROM words WHERE word IN (${ph})`
    ).values<[number, string]>(...wordList);
    const idWordMap = new Map<number, string>();
    for (const [id, word] of wordRows) idWordMap.set(id, word);

    const idList = [...idWordMap.keys()];
    if (idList.length === 0) return { ...result, wordScores: [] };

    const idPh = idList.map(() => "?").join(",");
    const matrixRows = db.prepare(
      `SELECT m.times, m.wordid, b.name
       FROM matrix m JOIN buckets b ON m.bucketid = b.id
       WHERE m.wordid IN (${idPh}) AND b.userid = ?`
    ).values<[number, number, string]>(...idList, userId);

    const matrix = new Map<number, Map<string, number>>();
    for (const [times, wordid, bucketName] of matrixRows) {
      if (!matrix.has(wordid)) matrix.set(wordid, new Map());
      matrix.get(wordid)!.set(bucketName, times);
    }

    const wordScores: WordScore[] = [];
    for (const id of idList) {
      const word = idWordMap.get(id)!;
      const freq = parsed.words.get(word) ?? 1;
      const wordMatrix = matrix.get(id);
      const bucketProbs = new Map<string, number>();
      let topBucket = buckets[0].name;
      let topProb = -1;
      for (const b of buckets) {
        const count = wordMatrix?.get(b.name) ?? 0;
        const total = bucketTotalWords.get(b.name) ?? 1;
        const prob = count > 0 ? count / total : 0;
        bucketProbs.set(b.name, prob);
        if (prob > topProb) { topProb = prob; topBucket = b.name; }
      }
      wordScores.push({ word, freq, bucketProbs, topBucket });
    }

    // Sort by discriminativeness = (max_prob − min_prob) × freq
    wordScores.sort((a, b) => {
      const disc = (ws: WordScore) =>
        (Math.max(...ws.bucketProbs.values()) - Math.min(...ws.bucketProbs.values())) * ws.freq;
      return disc(b) - disc(a);
    });

    return { ...result, wordScores: wordScores.slice(0, topN) };
  }

  /** Classify an already-parsed message (used internally). */
  classifyParsed(userId: number, parsed: ParseResult): ClassifyResultInternal {
    const buckets = this.#getBuckets(userId);
    const emptyResult: ClassifyResultInternal = {
      bucket: "unclassified",
      scores: new Map(),
      magnetUsed: false,
      magnetId: null,
    };

    if (buckets.length === 0) return emptyResult;

    // 1. Magnet check — explicit rules override Bayes
    const magnetMatch = this.#checkMagnets(userId, parsed);
    if (magnetMatch) {
      return {
        bucket: magnetMatch.bucket,
        scores: new Map([[magnetMatch.bucket, 1]]),
        magnetUsed: true,
        magnetId: magnetMatch.magnetId,
      };
    }

    // 2. Need at least 2 buckets with words to classify
    const notLikely = this.#notLikely.get(userId);
    if (notLikely === undefined || notLikely === 0) return emptyResult;

    const startMap = this.#bucketStart.get(userId);
    if (!startMap) return emptyResult;

    const activeBuckets = buckets.filter((b) => (startMap.get(b.name) ?? 0) !== 0);
    if (activeBuckets.length < 2) return emptyResult;

    // 3. Look up word IDs from the database for words in this message
    const wordList = [...parsed.words.keys()];
    if (wordList.length === 0) return emptyResult;

    const db = this.db_();
    const placeholders = wordList.map(() => "?").join(",");
    const wordRows = db.prepare(
      `SELECT id, word FROM words WHERE word IN (${placeholders})`
    ).values<[number, string]>(...wordList);

    const wordIdMap = new Map<string, number>();
    const idWordMap = new Map<number, string>();
    for (const [id, word] of wordRows) {
      wordIdMap.set(word, id);
      idWordMap.set(id, word);
    }

    const idList = [...idWordMap.keys()];
    if (idList.length === 0) return emptyResult;

    // 4. Fetch word×bucket counts from matrix
    const idPlaceholders = idList.map(() => "?").join(",");
    const matrixRows = db.prepare(
      `SELECT m.times, m.wordid, b.name
       FROM matrix m JOIN buckets b ON m.bucketid=b.id
       WHERE m.wordid IN (${idPlaceholders}) AND b.userid=?`
    ).values<[number, number, string]>(...idList, userId);

    // matrix[wordid][bucketName] = count
    const matrix = new Map<number, Map<string, number>>();
    for (const [times, wordid, bucketName] of matrixRows) {
      if (!matrix.has(wordid)) matrix.set(wordid, new Map());
      matrix.get(wordid)!.set(bucketName, times);
    }

    // 5. Bayes scoring loop (log-probability accumulation)
    const score = new Map<string, number>();
    const bucketTotalWords = this.#getBucketWordCounts(userId);

    for (const b of activeBuckets) {
      score.set(b.name, startMap.get(b.name) ?? 0);
    }

    for (const id of idList) {
      const word = idWordMap.get(id)!;
      const freq = parsed.words.get(word) ?? 1;
      const wordMatrix = matrix.get(id);

      for (const b of activeBuckets) {
        const count = wordMatrix?.get(b.name) ?? 0;
        const bucketTotal = bucketTotalWords.get(b.name) ?? 1;
        const probability = count > 0
          ? Math.log(count / bucketTotal)
          : notLikely;
        score.set(b.name, (score.get(b.name) ?? 0) + probability * freq);
      }
    }

    // 6. Rank buckets by score
    const ranking = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (ranking.length < 2) return emptyResult;

    const [topName, topScore] = ranking[0];
    const [, secondScore] = ranking[1];
    const unclassifiedWeight = Math.log(
      parseInt(this.config_("unclassified_weight"), 10)
    );

    const winningBucket =
      topScore > secondScore + unclassifiedWeight ? topName : "unclassified";

    // 7. Normalize to probabilities
    const baseScore = topScore;
    let total = 0;
    const normalizedScores = new Map<string, number>();
    for (const [name, s] of ranking) {
      const exp = Math.exp(s - baseScore);
      normalizedScores.set(name, exp);
      total += exp;
    }
    for (const [name, v] of normalizedScores) {
      normalizedScores.set(name, Math.min(0.999999, v / total));
    }

    return { bucket: winningBucket, scores: normalizedScores, magnetUsed: false, magnetId: null };
  }

  // -------------------------------------------------------------------------
  // Training
  // -------------------------------------------------------------------------

  /** Add a parsed message to a bucket's word counts. */
  trainMessage(sessionKey: string, bucketName: string, parsed: ParseResult): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");

    const bucket = this.#getBucketByName(userId, bucketName);
    if (!bucket) throw new Error(`Unknown bucket: ${bucketName}`);

    const db = this.db_();

    for (const [word, count] of parsed.words) {
      // Upsert into words table
      db.exec("INSERT OR IGNORE INTO words (word) VALUES (?)", word);
      const wordId = db.prepare("SELECT id FROM words WHERE word=?").value<[number]>(word)![0];

      // Upsert into matrix
      db.exec(
        `INSERT INTO matrix (wordid, bucketid, times) VALUES (?,?,?)
         ON CONFLICT(wordid, bucketid) DO UPDATE SET times=times+excluded.times`,
        wordId, bucket.id, count
      );
    }

    this.#updateConstants(userId);
  }

  // -------------------------------------------------------------------------
  // Bucket management
  // -------------------------------------------------------------------------

  getBuckets(sessionKey: string): string[] {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    return this.#getBuckets(userId).map((b) => b.name);
  }

  createBucket(sessionKey: string, name: string): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    db.exec("INSERT OR IGNORE INTO buckets (userid, name) VALUES (?,?)", userId, name);
    this.#updateConstants(userId);
  }

  deleteBucket(sessionKey: string, name: string): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    db.exec(
      "DELETE FROM buckets WHERE userid=? AND name=?",
      userId, name
    );
    this.#updateConstants(userId);
  }

  getBucketColors(sessionKey: string): Map<string, string> {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    const rows = db.prepare(`
      SELECT b.name, COALESCE(bp.val, bt.def)
      FROM buckets b
      JOIN bucket_template bt ON bt.name='color'
      LEFT JOIN bucket_params bp ON bp.bucketid=b.id AND bp.btid=bt.id
      WHERE b.userid=?
    `).values<[string, string]>(userId);
    return new Map(rows);
  }

  setBucketColor(sessionKey: string, bucketName: string, color: string): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const bucket = this.#getBucketByName(userId, bucketName);
    if (!bucket) throw new Error(`Unknown bucket: ${bucketName}`);
    const db = this.db_();
    const btRow = db.prepare("SELECT id FROM bucket_template WHERE name='color'").value<[number]>();
    if (!btRow) return;
    db.exec(
      `INSERT INTO bucket_params (bucketid, btid, val) VALUES (?,?,?)
       ON CONFLICT(bucketid, btid) DO UPDATE SET val=excluded.val`,
      bucket.id, btRow[0], color
    );
  }

  getBucketWordCount(sessionKey: string, bucketName: string): number {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    const row = db.prepare(
      `SELECT COALESCE(SUM(m.times),0) FROM matrix m
       JOIN buckets b ON m.bucketid=b.id
       WHERE b.userid=? AND b.name=?`
    ).value<[number]>(userId, bucketName);
    return row?.[0] ?? 0;
  }

  getStats(sessionKey: string): Stats {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();

    const totalClassified = db.prepare(
      "SELECT COUNT(*) FROM history WHERE userid=?"
    ).value<[number]>(userId)?.[0] ?? 0;

    const totalRetrained = db.prepare(
      "SELECT COUNT(*) FROM history WHERE userid=? AND usedtobe IS NOT NULL"
    ).value<[number]>(userId)?.[0] ?? 0;

    const magnetHits = db.prepare(
      "SELECT COUNT(*) FROM history WHERE userid=? AND magnetid IS NOT NULL"
    ).value<[number]>(userId)?.[0] ?? 0;

    // Per-bucket: word count, classification count, color
    const rows = db.prepare(`
      SELECT b.name,
             COALESCE(SUM(m.times), 0)                       AS words,
             COUNT(DISTINCT h.id)                             AS classified,
             COALESCE(bp.val, bt.def)                         AS color
      FROM   buckets b
      JOIN   bucket_template bt ON bt.name = 'color'
      LEFT   JOIN matrix m      ON m.bucketid = b.id
      LEFT   JOIN bucket_params bp ON bp.bucketid = b.id AND bp.btid = bt.id
      LEFT   JOIN history h     ON h.bucketid = b.id AND h.userid = b.userid
      WHERE  b.userid = ? AND b.pseudo = 0
      GROUP  BY b.id
      ORDER  BY b.name
    `).values<[string, number, number, string]>(userId);

    const buckets: BucketStat[] = rows.map(([name, wordCount, classifiedCount, color]) => ({
      name, color, wordCount, classifiedCount,
    }));

    const totalWords = buckets.reduce((s, b) => s + b.wordCount, 0);

    return { totalClassified, totalRetrained, magnetHits, totalWords, buckets };
  }

  // -------------------------------------------------------------------------
  // Magnet management
  // -------------------------------------------------------------------------

  addMagnet(sessionKey: string, bucketName: string, type: string, value: string): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    const bucket = this.#getBucketByName(userId, bucketName);
    if (!bucket) throw new Error(`Unknown bucket: ${bucketName}`);
    const typeRow = db.prepare("SELECT id FROM magnet_types WHERE name=?").value<[number]>(type);
    if (!typeRow) throw new Error(`Unknown magnet type: ${type}`);
    db.exec(
      "INSERT INTO magnets (bucketid, mtid, val) VALUES (?,?,?)",
      bucket.id, typeRow[0], value
    );
  }

  deleteMagnet(sessionKey: string, magnetId: number): void {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    db.exec(
      `DELETE FROM magnets WHERE id=?
       AND bucketid IN (SELECT id FROM buckets WHERE userid=?)`,
      magnetId, userId
    );
  }

  getMagnets(sessionKey: string): MagnetRow[] {
    const userId = this.#validSession(sessionKey);
    if (userId === null) throw new Error("Invalid session key");
    const db = this.db_();
    const rows = db.prepare(
      `SELECT mg.id, mt.name AS type, mg.val, b.name AS bucket
       FROM magnets mg
       JOIN magnet_types mt ON mg.mtid=mt.id
       JOIN buckets b ON mg.bucketid=b.id
       WHERE b.userid=?
       ORDER BY b.name, mt.name, mg.val`
    ).values<[number, string, string, string]>(userId);
    return rows.map(([id, type, val, bucketName]: [number, string, string, string]) => ({ id, type, val, bucketName }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  #getBuckets(userId: number): Bucket[] {
    const db = this.db_();
    const rows = db.prepare(
      "SELECT id, name, pseudo FROM buckets WHERE userid=? ORDER BY name"
    ).values<[number, string, number]>(userId);
    return rows.map(([id, name, pseudo]) => ({ id, name, pseudo: pseudo === 1 }));
  }

  #getBucketByName(userId: number, name: string): Bucket | null {
    const db = this.db_();
    const row = db.prepare(
      "SELECT id, name, pseudo FROM buckets WHERE userid=? AND name=?"
    ).value<[number, string, number]>(userId, name);
    return row ? { id: row[0], name: row[1], pseudo: row[2] === 1 } : null;
  }

  #getBucketWordCounts(userId: number): Map<string, number> {
    const db = this.db_();
    const rows = db.prepare(
      `SELECT b.name, COALESCE(SUM(m.times),0)
       FROM buckets b LEFT JOIN matrix m ON m.bucketid=b.id
       WHERE b.userid=? GROUP BY b.id`
    ).values<[string, number]>(userId);
    return new Map(rows);
  }

  #updateConstants(userId?: number): void {
    const db = this.db_();
    const userIds: number[] = userId !== undefined
      ? [userId]
      : db.prepare("SELECT id FROM users").values<[number]>().map((r) => r[0]);

    for (const uid of userIds) {
      const totals = this.#getBucketWordCounts(uid);
      const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);

      this.#notLikely.set(uid, grandTotal > 0 ? Math.log(1 / grandTotal) : 0);

      const buckets = this.#getBuckets(uid);
      const startMap = new Map<string, number>();
      for (const b of buckets) {
        const bTotal = totals.get(b.name) ?? 0;
        startMap.set(b.name, grandTotal > 0 ? Math.log(bTotal / grandTotal) : 0);
      }
      this.#bucketStart.set(uid, startMap);
    }
  }

  #writeHistory(userId: number, filePath: string, parsed: ParseResult, result: ClassifyResultInternal): void {
    const db = this.db_();
    const bucket = result.bucket !== "unclassified"
      ? this.#getBucketByName(userId, result.bucket)
      : null;
    db.exec(
      `INSERT INTO history (userid, filename, bucketid, magnetid, date, from_address, to_address, subject, inserted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      userId,
      filePath,
      bucket?.id ?? null,
      result.magnetId ?? null,
      Math.floor(Date.now() / 1000),
      parsed.headers.get("from") ?? "",
      parsed.headers.get("to") ?? "",
      parsed.headers.get("subject") ?? "",
    );
  }

  #untrainMessage(userId: number, bucketName: string, parsed: ParseResult): void {
    const bucket = this.#getBucketByName(userId, bucketName);
    if (!bucket) return;
    const db = this.db_();
    for (const [word, count] of parsed.words) {
      const wordRow = db.prepare("SELECT id FROM words WHERE word=?").value<[number]>(word);
      if (!wordRow) continue;
      db.exec(
        `UPDATE matrix SET times=MAX(0, times-?) WHERE wordid=? AND bucketid=?`,
        count, wordRow[0], bucket.id
      );
    }
    this.#updateConstants(userId);
  }

  #checkMagnets(userId: number, parsed: ParseResult): { bucket: string; magnetId: number } | null {
    const db = this.db_();
    const rows = db.prepare(
      `SELECT mg.id, mg.val, mt.name AS type, b.name AS bucket
       FROM magnets mg
       JOIN magnet_types mt ON mg.mtid=mt.id
       JOIN buckets b ON mg.bucketid=b.id
       WHERE b.userid=?`
    ).values<[number, string, string, string]>(userId);

    for (const [magnetId, val, type, bucket] of rows) {
      const headerValue = parsed.headers.get(type.toLowerCase()) ?? "";
      if (headerValue.toLowerCase().includes(val.toLowerCase())) {
        return { bucket, magnetId };
      }
    }
    return null;
  }
}
