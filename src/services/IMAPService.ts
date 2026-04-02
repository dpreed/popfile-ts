/**
 * IMAPService.ts — IMAP classification service.
 *
 * Mirrors Services::IMAP from the Perl original. Connects directly to an
 * IMAP server (no proxy), monitors a watch folder for unseen messages,
 * classifies each one with Bayes, and either moves it to the matching
 * bucket folder or leaves it in place with the \Seen flag set.
 *
 * Config keys (prefix "imap_"):
 *   server          IMAP hostname (required; empty = service disabled)
 *   port            Port (default 143; use 993 with tls=1)
 *   tls             Use TLS — 0 or 1 (default 0)
 *   username        Login username
 *   password        Login password
 *   watch_folder    Folder to monitor (default INBOX)
 *   move            Move classified messages to bucket folders (default 1)
 *   folder_prefix   Prepended to bucket name when creating folders (default "")
 *   interval        Seconds between checks (default 60)
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";

// ---------------------------------------------------------------------------
// Low-level IMAP client
// ---------------------------------------------------------------------------

class IMAPClient {
  #conn: Deno.Conn;
  #buf = new Uint8Array(0);
  #tagSeq = 0;

  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }

  static async connect(host: string, port: number, tls: boolean): Promise<IMAPClient> {
    const conn = tls
      ? await Deno.connectTls({ hostname: host, port })
      : await Deno.connect({ hostname: host, port });
    return new IMAPClient(conn);
  }

  close(): void {
    try { this.#conn.close(); } catch { /* ok */ }
  }

  #nextTag(): string {
    return `PF${String(++this.#tagSeq).padStart(4, "0")}`;
  }

  async #write(data: string): Promise<void> {
    await this.#conn.write(new TextEncoder().encode(data));
  }

  // Read until \r\n, buffering partial reads.
  async #readLine(): Promise<string> {
    const dec = new TextDecoder();
    while (true) {
      for (let i = 0; i < this.#buf.length - 1; i++) {
        if (this.#buf[i] === 0x0d && this.#buf[i + 1] === 0x0a) {
          const line = dec.decode(this.#buf.slice(0, i));
          this.#buf = this.#buf.slice(i + 2);
          return line;
        }
      }
      const tmp = new Uint8Array(4096);
      const n = await this.#conn.read(tmp);
      if (n === null) throw new Error("IMAP connection closed");
      const merged = new Uint8Array(this.#buf.length + n);
      merged.set(this.#buf);
      merged.set(tmp.slice(0, n), this.#buf.length);
      this.#buf = merged;
    }
  }

  // Read exactly n bytes from the connection (for IMAP literals).
  async #readBytes(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) {
      const tmp = new Uint8Array(Math.max(4096, n - this.#buf.length));
      const read = await this.#conn.read(tmp);
      if (read === null) throw new Error("IMAP connection closed");
      const merged = new Uint8Array(this.#buf.length + read);
      merged.set(this.#buf);
      merged.set(tmp.slice(0, read), this.#buf.length);
      this.#buf = merged;
    }
    const result = this.#buf.slice(0, n);
    this.#buf = this.#buf.slice(n);
    return result;
  }

  // Read and discard lines until we see the tagged response.
  async #drain(tag: string): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = [];
    while (true) {
      const line = await this.#readLine();
      lines.push(line);
      if (line.startsWith(`${tag} OK`)) return { ok: true, lines };
      if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
        return { ok: false, lines };
      }
    }
  }

  async #command(cmd: string): Promise<{ ok: boolean; lines: string[] }> {
    const tag = this.#nextTag();
    await this.#write(`${tag} ${cmd}\r\n`);
    return await this.#drain(tag);
  }

  // -------------------------------------------------------------------------
  // IMAP operations
  // -------------------------------------------------------------------------

  /** Read the server greeting (call once after connect). */
  async readGreeting(): Promise<void> {
    await this.#readLine();
  }

  async login(user: string, pass: string): Promise<boolean> {
    // Escape double-quotes in credentials
    const u = user.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const p = pass.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return (await this.#command(`LOGIN "${u}" "${p}"`)).ok;
  }

  /** SELECT a mailbox; returns the EXISTS count. */
  async select(mailbox: string): Promise<number> {
    const { ok, lines } = await this.#command(`SELECT "${mailbox}"`);
    if (!ok) return 0;
    for (const line of lines) {
      const m = line.match(/^\* (\d+) EXISTS/);
      if (m) return parseInt(m[1]);
    }
    return 0;
  }

  /** SEARCH with arbitrary criteria string; returns sequence numbers. */
  async search(criteria: string): Promise<number[]> {
    const { ok, lines } = await this.#command(`SEARCH ${criteria}`);
    if (!ok) return [];
    for (const line of lines) {
      const m = line.match(/^\* SEARCH(.*)/);
      if (m) return m[1].trim().split(/\s+/).filter(Boolean).map(Number);
    }
    return [];
  }

  /**
   * FETCH a message body using BODY.PEEK[] (non-marking).
   * Handles IMAP literal syntax {n} to read the raw bytes.
   */
  async fetchRaw(seqNum: number): Promise<string | null> {
    const tag = this.#nextTag();
    await this.#write(`${tag} FETCH ${seqNum} BODY.PEEK[]\r\n`);

    let body: string | null = null;
    while (true) {
      const line = await this.#readLine();
      if (line.startsWith(`${tag} OK`)) break;
      if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) return null;

      // IMAP literal: line ends with {n}
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const bytes = await this.#readBytes(parseInt(lit[1]));
        // latin-1 decode to preserve 8-bit bytes faithfully
        body = new TextDecoder("latin1").decode(bytes);
        await this.#readLine(); // consume the closing ")"
      }
    }
    return body;
  }

  async copy(seqNum: number, mailbox: string): Promise<boolean> {
    return (await this.#command(`COPY ${seqNum} "${mailbox}"`)).ok;
  }

  async store(seqNum: number, flagSpec: string): Promise<boolean> {
    return (await this.#command(`STORE ${seqNum} ${flagSpec}`)).ok;
  }

  async expunge(): Promise<void> {
    await this.#command("EXPUNGE");
  }

  /** Create a mailbox; returns false if it already exists (that is OK). */
  async createMailbox(name: string): Promise<boolean> {
    return (await this.#command(`CREATE "${name}"`)).ok;
  }

  /** LIST mailboxes matching pattern; returns bare names. */
  async listMailboxes(ref: string, pattern: string): Promise<string[]> {
    const { ok, lines } = await this.#command(`LIST "${ref}" "${pattern}"`);
    if (!ok) return [];
    return lines
      .filter((l) => l.startsWith("* LIST"))
      .map((l) => {
        // * LIST (\flags) "/" "Name"  or  * LIST (\flags) "/" Name
        const m = l.match(/\* LIST [^)]*\)\s+\S+\s+"?([^"\r\n]+)"?/);
        return m ? m[1].trim() : "";
      })
      .filter(Boolean);
  }

  async logout(): Promise<void> {
    await this.#command("LOGOUT").catch(() => {});
    this.close();
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const BACKOFF_INITIAL = 30_000;   // 30 s
const BACKOFF_MAX     = 1_800_000; // 30 min

export class IMAPService extends Module {
  #client: IMAPClient | null = null;
  #lastCheck = 0;
  #running = false;
  #session = "";
  #failureDelay = 0;   // current back-off step (ms); 0 = no active back-off
  #nextRetry = 0;      // absolute timestamp before which we must not retry

  constructor() {
    super();
    this.name_ = "imap";
  }

  override initialize(): LifecycleResult {
    this.config_("server", "");
    this.config_("port", "143");
    this.config_("tls", "0");
    this.config_("username", "");
    this.config_("password", "");
    this.config_("watch_folder", "INBOX");
    this.config_("move", "1");
    this.config_("folder_prefix", "");
    this.config_("interval", "60");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    if (!this.config_("server")) {
      this.log_(0, "IMAP server not configured — service disabled");
      return LifecycleResult.Skip;
    }
    const bayes = this.getModule_<Bayes>("classifier");
    this.#session = bayes.getAdministratorSessionKey();
    this.log_(0, `IMAP service enabled — server: ${this.config_("server")}:${this.config_("port")}`);
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#client?.logout().catch(() => {});
    this.#client = null;
  }

  override service(): boolean {
    if (!this.config_("server") || this.#running) return true;
    const now = Date.now();
    if (now < this.#nextRetry) return true;
    const interval = parseInt(this.config_("interval")) * 1000;
    if (now - this.#lastCheck < interval) return true;
    this.#lastCheck = now;
    this.#running = true;
    this.#checkAndClassify()
      .then(() => {
        this.#failureDelay = 0;
        this.#nextRetry = 0;
      })
      .catch((e) => {
        this.log_(0, `IMAP error: ${e}`);
        this.#client?.close();
        this.#client = null;
        this.#failureDelay = this.#failureDelay === 0
          ? BACKOFF_INITIAL
          : Math.min(this.#failureDelay * 2, BACKOFF_MAX);
        this.#nextRetry = Date.now() + this.#failureDelay;
        this.log_(0, `IMAP: next retry in ${this.#failureDelay / 1000}s`);
      })
      .finally(() => { this.#running = false; });
    return true;
  }

  // -------------------------------------------------------------------------
  // Classification pass
  // -------------------------------------------------------------------------

  async #checkAndClassify(): Promise<void> {
    const server   = this.config_("server");
    const port     = parseInt(this.config_("port"));
    const tls      = this.config_("tls") === "1";
    const user     = this.config_("username");
    const pass     = this.config_("password");
    const watch    = this.config_("watch_folder");
    const doMove   = this.config_("move") === "1";
    const prefix   = this.config_("folder_prefix");

    // (Re)connect if needed
    if (!this.#client) {
      this.log_(1, `Connecting to ${server}:${port}${tls ? " (TLS)" : ""}`);
      this.#client = await IMAPClient.connect(server, port, tls);
      await this.#client.readGreeting();
      if (!await this.#client.login(user, pass)) {
        this.log_(0, "IMAP login failed — check username/password");
        this.#client.close();
        this.#client = null;
        return;
      }
      this.log_(1, "IMAP login OK");
    }

    const client = this.#client;
    const exists = await client.select(watch);
    this.log_(1, `${watch}: ${exists} message(s)`);
    if (exists === 0) return;

    const unseen = await client.search("UNSEEN");
    if (unseen.length === 0) { this.log_(1, "No unseen messages"); return; }
    this.log_(0, `Classifying ${unseen.length} unseen message(s)`);

    const bayes  = this.getModule_<Bayes>("classifier");
    const parser = new MailParser();
    let classified = 0;
    // Track seq nums to delete in one EXPUNGE after the loop
    const toDelete: number[] = [];

    for (const seqNum of unseen) {
      const raw = await client.fetchRaw(seqNum);
      if (raw === null) {
        this.log_(1, `Could not fetch message ${seqNum} — skipping`);
        continue;
      }

      // Write to temp file so MailParser can use its file path API
      const tmp = await Deno.makeTempFile({ suffix: ".eml" });
      try {
        // Encode as latin-1 bytes to preserve 8-bit content faithfully
        const enc = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) enc[i] = raw.charCodeAt(i) & 0xff;
        await Deno.writeFile(tmp, enc);
        const parsed = parser.parseFile(tmp);
        const result = bayes.classifyMessage(this.#session, parsed);
        const bucket = result.bucket;

        this.log_(1, `  #${seqNum} "${parsed.headers.get("subject") ?? ""}" → ${bucket}`);

        if (doMove && bucket !== "unclassified") {
          const dest = prefix ? `${prefix}/${bucket}` : bucket;
          await client.createMailbox(dest); // no-op if already exists
          if (await client.copy(seqNum, dest)) {
            await client.store(seqNum, "+FLAGS.SILENT (\\Deleted \\Seen)");
            toDelete.push(seqNum);
            classified++;
          }
        } else {
          await client.store(seqNum, "+FLAGS.SILENT (\\Seen)");
          classified++;
        }
      } finally {
        await Deno.remove(tmp).catch(() => {});
      }
    }

    if (toDelete.length > 0) await client.expunge();
    this.log_(0, `IMAP: ${classified}/${unseen.length} messages classified`);
  }
}
