// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * tests/imap_test.ts — End-to-end tests for IMAPService.
 *
 * Spins up a minimal fake IMAP server, boots the full module stack with
 * IMAPService configured to point at it, calls `poll()` to trigger an
 * immediate classification pass (bypassing the interval timer), and asserts
 * on what the fake server received.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/imap_test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { IMAPService } from "../services/IMAPService.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Fake IMAP server
// ---------------------------------------------------------------------------

interface FakeMessage {
  raw: string;
  unseen: boolean;
}

/** Records every command the fake server received. */
interface ServerLog {
  commands: string[];
  /** Destination mailboxes passed to COPY commands, in order. */
  copyDests: string[];
  /** Mailboxes created via CREATE. */
  created: string[];
  /** Whether EXPUNGE was called. */
  expunged: boolean;
}

class FakeIMAPServer {
  readonly port: number;
  readonly log: ServerLog = { commands: [], copyDests: [], created: [], expunged: false };

  #listener: Deno.Listener;
  #messages: Map<number, FakeMessage>;
  #loginOk: boolean;

  private constructor(
    listener: Deno.Listener,
    messages: Map<number, FakeMessage>,
    loginOk: boolean,
  ) {
    this.#listener = listener;
    this.#messages = messages;
    this.#loginOk = loginOk;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#acceptLoop();
  }

  static start(
    messages: Map<number, FakeMessage> = new Map(),
    loginOk = true,
  ): FakeIMAPServer {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    return new FakeIMAPServer(listener, messages, loginOk);
  }

  close(): void {
    try { this.#listener.close(); } catch { /* ok */ }
  }

  async #acceptLoop(): Promise<void> {
    for await (const conn of this.#listener) {
      this.#serveConn(conn).catch(() => {});
    }
  }

  async #serveConn(conn: Deno.Conn): Promise<void> {
    const enc = new TextEncoder();
    const send = async (s: string) => { await conn.write(enc.encode(s + "\r\n")); };
    const buf = new Uint8Array(8192);
    let leftover = "";

    const readLine = async (): Promise<string | null> => {
      while (true) {
        const cr = leftover.indexOf("\r\n");
        if (cr !== -1) {
          const line = leftover.slice(0, cr);
          leftover = leftover.slice(cr + 2);
          return line;
        }
        let n: number | null;
        try { n = await conn.read(buf); } catch { return null; }
        if (n === null || n === 0) return null;
        leftover += new TextDecoder().decode(buf.slice(0, n));
      }
    };

    // Greeting
    await send("* OK IMAP server ready");

    try {
      while (true) {
        const raw = await readLine();
        if (raw === null) break;
        const line = raw.trimEnd();

        // Parse tag and rest
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx === -1) continue;
        const tag = line.slice(0, spaceIdx);
        const rest = line.slice(spaceIdx + 1);
        const upper = rest.toUpperCase();

        this.log.commands.push(rest);

        if (upper.startsWith("LOGIN ")) {
          if (this.#loginOk) {
            await send(`${tag} OK LOGIN completed`);
          } else {
            await send(`${tag} NO LOGIN failed`);
            break;
          }

        } else if (upper.startsWith("SELECT ")) {
          const unseenNums = [...this.#messages.entries()]
            .filter(([, m]) => m.unseen)
            .map(([n]) => n);
          const total = this.#messages.size;
          const firstUnseen = unseenNums[0] ?? 0;
          await send(`* ${total} EXISTS`);
          await send(`* ${unseenNums.length} RECENT`);
          if (firstUnseen) await send(`* OK [UNSEEN ${firstUnseen}] First unseen`);
          await send(`* OK [UIDVALIDITY 1] UIDs valid`);
          await send(`${tag} OK [READ-WRITE] SELECT completed`);

        } else if (upper.startsWith("SEARCH ")) {
          const unseenNums = [...this.#messages.entries()]
            .filter(([, m]) => m.unseen)
            .map(([n]) => n);
          await send(`* SEARCH${unseenNums.length ? " " + unseenNums.join(" ") : ""}`);
          await send(`${tag} OK SEARCH completed`);

        } else if (upper.startsWith("FETCH ")) {
          // "FETCH N BODY.PEEK[]"
          const parts = rest.split(/\s+/);
          const seqNum = parseInt(parts[1], 10);
          const msg = this.#messages.get(seqNum);
          if (!msg) {
            await send(`${tag} NO No such message`);
          } else {
            const bodyBytes = new TextEncoder().encode(msg.raw);
            await send(`* ${seqNum} FETCH (BODY[] {${bodyBytes.length}}`);
            await conn.write(bodyBytes);
            await send("\r\n)");
            await send(`${tag} OK FETCH completed`);
          }

        } else if (upper.startsWith("COPY ")) {
          // "COPY N "dest""
          const m = rest.match(/^COPY\s+\d+\s+"?([^"]+)"?/i);
          const dest = m ? m[1] : "";
          this.log.copyDests.push(dest);
          await send(`${tag} OK COPY completed`);

        } else if (upper.startsWith("STORE ")) {
          // Mark message as seen/deleted locally so re-queries reflect it
          const m = rest.match(/^STORE\s+(\d+)\s+/i);
          if (m) {
            const n = parseInt(m[1], 10);
            const msg = this.#messages.get(n);
            if (msg) msg.unseen = false;
          }
          await send(`${tag} OK STORE completed`);

        } else if (upper === "EXPUNGE") {
          this.log.expunged = true;
          // Remove deleted messages
          const nums = [...this.#messages.keys()];
          for (const n of nums) {
            await send(`* ${n} EXPUNGE`);
          }
          await send(`${tag} OK EXPUNGE completed`);

        } else if (upper.startsWith("CREATE ")) {
          const m = rest.match(/^CREATE\s+"?([^"]+)"?/i);
          const name = m ? m[1] : "";
          this.log.created.push(name);
          await send(`${tag} OK CREATE completed`);

        } else if (upper.startsWith("LIST ")) {
          await send(`* LIST (\\HasNoChildren) "/" INBOX`);
          await send(`${tag} OK LIST completed`);

        } else if (upper === "LOGOUT") {
          await send("* BYE Goodbye");
          await send(`${tag} OK LOGOUT completed`);
          break;

        } else {
          await send(`${tag} BAD unknown command`);
        }
      }
    } finally {
      try { conn.close(); } catch { /* ok */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test stack
// ---------------------------------------------------------------------------

interface IMAPStack {
  service: IMAPService;
  bayes: Bayes;
  session: string;
  cleanup: () => void;
}

async function makeIMAPStack(
  fakePort: number,
  overrides: Record<string, string> = {},
): Promise<IMAPStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("imap",      new IMAPService(),    4);

  const modules = ["config", "mq", "logger", "database", "classifier", "imap"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("GLOBAL_user_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  config.parameter("logger_log_dir",   join(tmpDir, "logs"));
  config.parameter("imap_server",      "127.0.0.1");
  config.parameter("imap_port",        String(fakePort));
  config.parameter("imap_username",    "testuser");
  config.parameter("imap_password",    "testpass");
  config.parameter("imap_interval",    "60");

  for (const [k, v] of Object.entries(overrides)) config.parameter(k, v);

  for (const alias of modules) loader.getModule(alias).start();

  const service = loader.getModule("imap") as IMAPService;
  const bayes   = loader.getModule("classifier") as Bayes;
  const session = bayes.getAdministratorSessionKey();

  return {
    service,
    bayes,
    session,
    cleanup() {
      bayes.releaseSessionKey(session);
      for (const alias of [...modules].reverse()) {
        try { loader.getModule(alias).stop(); } catch { /* ok */ }
      }
      Deno.removeSync(tmpDir, { recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture messages
// ---------------------------------------------------------------------------

const SPAM_MSG = [
  "From: spammer@evil.com",
  "To: victim@example.com",
  "Subject: Buy cheap pills now FREE SHIPPING",
  "",
  "Click here to purchase discount pharmaceuticals at amazing prices.",
  "Limited time offer act now free shipping worldwide buy now.",
].join("\r\n");

const HAM_MSG = [
  "From: alice@example.com",
  "To: bob@example.com",
  "Subject: Meeting tomorrow",
  "",
  "Hi Bob, can we meet tomorrow at 10am to discuss the project?",
  "Let me know if that works for you. Thanks, Alice.",
].join("\r\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("IMAPService: disabled when imap_server not configured", async () => {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();
  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("imap",      new IMAPService(),    4);
  const modules = ["config", "mq", "logger", "database", "classifier", "imap"];
  for (const alias of modules) loader.getModule(alias).initialize();
  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir", tmpDir);
  config.parameter("config_root_dir", tmpDir);
  config.parameter("GLOBAL_user_dir", tmpDir);
  config.parameter("logger_log_level", "0");
  // Leave imap_server empty (default)
  const results: string[] = [];
  for (const alias of modules) {
    const r = loader.getModule(alias).start();
    if (alias === "imap") results.push(String(r));
  }
  try {
    // "2" = LifecycleResult.Skip
    assertEquals(results[0], "2", "IMAPService should return Skip when server not configured");
  } finally {
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("IMAPService: failed login does not throw", async () => {
  const fake = FakeIMAPServer.start(new Map(), false /* loginOk = false */);
  const stack = await makeIMAPStack(fake.port);
  try {
    // Should complete without throwing even though login fails
    await stack.service.poll();
    // LOGIN command was sent
    assert(
      stack.service instanceof IMAPService,
      "Service should still be alive after login failure",
    );
    assert(
      fake.log.commands.some((c) => c.toUpperCase().startsWith("LOGIN")),
      "LOGIN should have been attempted",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: no unseen messages — no FETCH issued", async () => {
  // All messages have unseen=false
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: SPAM_MSG, unseen: false }],
  ]);
  const fake = FakeIMAPServer.start(msgs);
  const stack = await makeIMAPStack(fake.port);
  try {
    await stack.service.poll();
    assert(
      !fake.log.commands.some((c) => c.toUpperCase().startsWith("FETCH")),
      "FETCH should not be called when there are no unseen messages",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: unseen message marked \\Seen when move=0", async () => {
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: HAM_MSG, unseen: true }],
  ]);
  const fake = FakeIMAPServer.start(msgs);
  const stack = await makeIMAPStack(fake.port, { imap_move: "0" });
  try {
    await stack.service.poll();
    // STORE should have been called to mark \Seen
    assert(
      fake.log.commands.some((c) => c.toUpperCase().startsWith("STORE") && c.includes("Seen")),
      "STORE +FLAGS \\Seen expected",
    );
    // COPY should NOT have been called
    assert(
      !fake.log.commands.some((c) => c.toUpperCase().startsWith("COPY")),
      "COPY should not be called when move=0",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: classified message moved to bucket folder when move=1", async () => {
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: SPAM_MSG, unseen: true }],
  ]);
  const fake = FakeIMAPServer.start(msgs);

  // Train classifier so message gets a real bucket
  const stack = await makeIMAPStack(fake.port, { imap_move: "1" });
  const parser = new MailParser();
  stack.bayes.createBucket(stack.session, "spam");
  stack.bayes.createBucket(stack.session, "inbox");
  for (let i = 0; i < 3; i++) {
    const sf = await Deno.makeTempFile({ suffix: ".eml" });
    const hf = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(sf, SPAM_MSG);
      await Deno.writeTextFile(hf, HAM_MSG);
      stack.bayes.trainMessage(stack.session, "spam",  parser.parseFile(sf));
      stack.bayes.trainMessage(stack.session, "inbox", parser.parseFile(hf));
    } finally {
      await Deno.remove(sf).catch(() => {});
      await Deno.remove(hf).catch(() => {});
    }
  }

  try {
    await stack.service.poll();

    // COPY should move message to the classified bucket
    assert(fake.log.copyDests.length > 0, "Expected COPY to a bucket folder");
    assert(
      fake.log.copyDests[0] === "spam",
      `Expected copy to 'spam', got: '${fake.log.copyDests[0]}'`,
    );
    // EXPUNGE should clean up deleted messages
    assert(fake.log.expunged, "Expected EXPUNGE after moving messages");
    // CREATE should have been called for the destination folder
    assert(
      fake.log.created.includes("spam"),
      "Expected CREATE for spam folder",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: unclassified message marked \\Seen but not moved", async () => {
  // With no training the classifier returns "unclassified"
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: HAM_MSG, unseen: true }],
  ]);
  const fake = FakeIMAPServer.start(msgs);
  const stack = await makeIMAPStack(fake.port, { imap_move: "1" });
  try {
    await stack.service.poll();
    // No COPY — unclassified messages are not moved
    assert(
      !fake.log.commands.some((c) => c.toUpperCase().startsWith("COPY")),
      "COPY should not be called for unclassified messages",
    );
    // But STORE \Seen should still be set
    assert(
      fake.log.commands.some((c) => c.toUpperCase().startsWith("STORE") && c.includes("Seen")),
      "STORE \\Seen expected even for unclassified",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: folder prefix is prepended to bucket name", async () => {
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: SPAM_MSG, unseen: true }],
  ]);
  const fake = FakeIMAPServer.start(msgs);

  const stack = await makeIMAPStack(fake.port, {
    imap_move: "1",
    imap_folder_prefix: "POPFile",
  });
  const parser = new MailParser();
  stack.bayes.createBucket(stack.session, "spam");
  stack.bayes.createBucket(stack.session, "inbox");
  for (let i = 0; i < 3; i++) {
    const sf = await Deno.makeTempFile({ suffix: ".eml" });
    const hf = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(sf, SPAM_MSG);
      await Deno.writeTextFile(hf, HAM_MSG);
      stack.bayes.trainMessage(stack.session, "spam",  parser.parseFile(sf));
      stack.bayes.trainMessage(stack.session, "inbox", parser.parseFile(hf));
    } finally {
      await Deno.remove(sf).catch(() => {});
      await Deno.remove(hf).catch(() => {});
    }
  }

  try {
    await stack.service.poll();
    assert(
      fake.log.copyDests.some((d) => d === "POPFile/spam"),
      `Expected copy to 'POPFile/spam', got: ${JSON.stringify(fake.log.copyDests)}`,
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: multiple unseen messages are all processed", async () => {
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: SPAM_MSG, unseen: true }],
    [2, { raw: HAM_MSG,  unseen: true }],
    [3, { raw: SPAM_MSG, unseen: true }],
  ]);
  const fake = FakeIMAPServer.start(msgs);
  const stack = await makeIMAPStack(fake.port, { imap_move: "0" });
  try {
    await stack.service.poll();
    // FETCH should have been called 3 times
    const fetches = fake.log.commands.filter((c) => c.toUpperCase().startsWith("FETCH"));
    assertEquals(fetches.length, 3, "Expected 3 FETCH calls");
    // STORE should have been called 3 times
    const stores = fake.log.commands.filter((c) => c.toUpperCase().startsWith("STORE"));
    assertEquals(stores.length, 3, "Expected 3 STORE calls");
  } finally {
    stack.cleanup();
    fake.close();
  }
});

Deno.test("IMAPService: SELECT and SEARCH are always issued per poll", async () => {
  const msgs: Map<number, FakeMessage> = new Map([
    [1, { raw: SPAM_MSG, unseen: false }],
  ]);
  const fake = FakeIMAPServer.start(msgs);
  const stack = await makeIMAPStack(fake.port);
  try {
    await stack.service.poll();
    assert(
      fake.log.commands.some((c) => c.toUpperCase().startsWith("SELECT")),
      "SELECT should be issued",
    );
    assert(
      fake.log.commands.some((c) => c.toUpperCase().startsWith("SEARCH")),
      "SEARCH should be issued",
    );
  } finally {
    stack.cleanup();
    fake.close();
  }
});
