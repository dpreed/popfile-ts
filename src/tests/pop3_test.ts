/**
 * tests/pop3_test.ts — End-to-end tests for POP3Proxy.
 *
 * Spins up a minimal fake POP3 server, boots the full module stack with
 * POP3Proxy on port 0, then drives a real TCP client through the proxy and
 * asserts on the classified responses.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/pop3_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { POP3Proxy } from "../proxy/POP3Proxy.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Fake POP3 server
// ---------------------------------------------------------------------------

/** Minimal POP3 server that serves a fixed set of messages. */
class FakePOP3Server {
  readonly port: number;
  #listener: Deno.Listener;
  #messages: Map<number, string>;

  private constructor(listener: Deno.Listener, messages: Map<number, string>) {
    this.#listener = listener;
    this.#messages = messages;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#acceptLoop();
  }

  static start(messages: Map<number, string>): FakePOP3Server {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    return new FakePOP3Server(listener, messages);
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
    const sendLine = (s: string) => conn.write(enc.encode(s + "\r\n"));
    const read = makeTcpLineReader(conn);

    await sendLine("+OK POP3 fake server ready");

    let loggedIn = false;
    try {
      while (true) {
        const raw = await read();
        if (raw === null) break;
        const line = raw.trim();
        const upper = line.toUpperCase();

        if (upper.startsWith("USER ")) {
          await sendLine("+OK");
        } else if (upper.startsWith("PASS ")) {
          loggedIn = true;
          await sendLine("+OK logged in");
        } else if (upper === "LIST" && loggedIn) {
          await sendLine(`+OK ${this.#messages.size} messages`);
          for (const [num, body] of this.#messages) {
            await sendLine(`${num} ${body.length}`);
          }
          await sendLine(".");
        } else if (upper.startsWith("RETR ") && loggedIn) {
          const num = parseInt(line.slice(5).trim(), 10);
          const body = this.#messages.get(num);
          if (!body) {
            await sendLine("-ERR no such message");
          } else {
            await sendLine(`+OK ${body.length} octets`);
            for (const msgLine of body.split("\r\n")) {
              // Byte-stuff lines beginning with "."
              await sendLine(msgLine.startsWith(".") ? "." + msgLine : msgLine);
            }
            await sendLine(".");
          }
        } else if (upper === "QUIT") {
          await sendLine("+OK bye");
          break;
        } else {
          await sendLine("-ERR unknown command");
        }
      }
    } finally {
      try { conn.close(); } catch { /* ok */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared line-reader factory (used by both fake server and test client)
// ---------------------------------------------------------------------------

function makeTcpLineReader(conn: Deno.Conn): () => Promise<string | null> {
  const buf = new Uint8Array(4096);
  let leftover = "";
  return async (): Promise<string | null> => {
    while (true) {
      const nl = leftover.indexOf("\n");
      if (nl !== -1) {
        const line = leftover.slice(0, nl + 1);
        leftover = leftover.slice(nl + 1);
        return line.replace(/\r\n$/, "").replace(/\n$/, "");
      }
      let n: number | null;
      try { n = await conn.read(buf); } catch { return null; }
      if (n === null || n === 0) return leftover.length > 0 ? leftover : null;
      leftover += new TextDecoder().decode(buf.slice(0, n));
    }
  };
}

// ---------------------------------------------------------------------------
// Minimal POP3 client helper
// ---------------------------------------------------------------------------

interface POP3Client {
  conn: Deno.Conn;
  send: (s: string) => Promise<void>;
  readLine: () => Promise<string | null>;
  /** Read lines until a bare "." terminator; returns lines without the dot. */
  readMultiLine: () => Promise<string[]>;
  close: () => void;
}

async function connectPOP3(port: number): Promise<POP3Client> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const enc = new TextEncoder();
  const readLine = makeTcpLineReader(conn);
  return {
    conn,
    send: (s: string) => conn.write(enc.encode(s + "\r\n")).then(() => {}),
    readLine,
    async readMultiLine(): Promise<string[]> {
      const lines: string[] = [];
      while (true) {
        const line = await readLine();
        if (line === null || line === ".") break;
        // Un-byte-stuff
        lines.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return lines;
    },
    close() { try { conn.close(); } catch { /* ok */ } },
  };
}

// ---------------------------------------------------------------------------
// Test stack
// ---------------------------------------------------------------------------

interface POP3Stack {
  proxy: POP3Proxy;
  bayes: Bayes;
  session: string;
  proxyPort: number;
  cleanup: () => void;
}

async function makePOP3Stack(fakeServerPort: number): Promise<POP3Stack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("pop3",      new POP3Proxy(),      4);

  const modules = ["config", "mq", "logger", "database", "classifier", "pop3"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("GLOBAL_user_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  config.parameter("logger_log_dir",   join(tmpDir, "logs"));
  // Use port 0 so OS assigns a free port
  config.parameter("pop3_port",        "0");
  // Point proxy's default upstream at the fake server
  config.parameter("pop3_upstream_port", String(fakeServerPort));

  for (const alias of modules) loader.getModule(alias).start();

  const proxy = loader.getModule("pop3") as POP3Proxy;
  const bayes = loader.getModule("classifier") as Bayes;
  const session = bayes.getAdministratorSessionKey();
  const proxyPort = proxy.getListenPort();

  return {
    proxy,
    bayes,
    session,
    proxyPort,
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
// Helpers
// ---------------------------------------------------------------------------

const SPAM_EML = [
  "From: spammer@evil.com",
  "To: victim@example.com",
  "Subject: Buy cheap pills now FREE SHIPPING",
  "",
  "Click here to purchase discount pharmaceuticals at amazing prices.",
  "Limited time offer act now free shipping worldwide buy now.",
].join("\r\n");

const HAM_EML = [
  "From: alice@example.com",
  "To: bob@example.com",
  "Subject: Meeting tomorrow",
  "",
  "Hi Bob, can we meet tomorrow at 10am to discuss the project?",
  "Let me know if that works for you. Thanks, Alice.",
].join("\r\n");

/** Perform USER + PASS handshake through the proxy to the fake server. */
async function login(
  client: POP3Client,
  proxyPort: number,
  fakePort: number,
): Promise<void> {
  // Read proxy banner
  const banner = await client.readLine();
  assert(banner?.startsWith("+OK"), `Expected banner, got: ${banner}`);

  await client.send(`USER testuser:127.0.0.1:${fakePort}`);
  const userResp = await client.readLine();
  assert(userResp?.startsWith("+OK"), `Expected +OK after USER, got: ${userResp}`);

  await client.send("PASS testpass");
  const passResp = await client.readLine();
  assert(passResp?.startsWith("+OK"), `Expected +OK after PASS, got: ${passResp}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("POP3Proxy: RETR response contains X-Text-Classification header", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3Stack(fake.port);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, stack.proxyPort, fake.port);

    await client.send("RETR 1");
    const firstLine = await client.readLine();
    assert(firstLine?.startsWith("+OK"), `Expected +OK for RETR, got: ${firstLine}`);

    const bodyLines = await client.readMultiLine();
    const fullMessage = bodyLines.join("\n");
    assert(
      fullMessage.includes("X-Text-Classification:"),
      `Expected X-Text-Classification header in:\n${fullMessage}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("POP3Proxy: classifies spam message correctly after training", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3Stack(fake.port);

  // Train the classifier before connecting
  const parser = new MailParser();
  for (let i = 0; i < 3; i++) {
    const spamFile = await Deno.makeTempFile({ suffix: ".eml" });
    const hamFile  = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(spamFile, SPAM_EML);
      await Deno.writeTextFile(hamFile,  HAM_EML);
      stack.bayes.createBucket(stack.session, "spam");
      stack.bayes.createBucket(stack.session, "inbox");
      stack.bayes.trainMessage(stack.session, "spam",  parser.parseFile(spamFile));
      stack.bayes.trainMessage(stack.session, "inbox", parser.parseFile(hamFile));
    } finally {
      await Deno.remove(spamFile).catch(() => {});
      await Deno.remove(hamFile).catch(() => {});
    }
  }

  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, stack.proxyPort, fake.port);

    await client.send("RETR 1");
    const firstLine = await client.readLine();
    assert(firstLine?.startsWith("+OK"), `Expected +OK for RETR, got: ${firstLine}`);

    const bodyLines = await client.readMultiLine();
    const header = bodyLines.find((l) => l.startsWith("X-Text-Classification:"));
    assert(header !== undefined, "X-Text-Classification header missing");
    assert(
      header.includes("spam"),
      `Expected 'spam' classification, got: ${header}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("POP3Proxy: LIST returns message count from upstream", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML], [2, HAM_EML]]));
  const stack = await makePOP3Stack(fake.port);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, stack.proxyPort, fake.port);

    await client.send("LIST");
    const listResp = await client.readLine();
    assert(listResp?.startsWith("+OK"), `Expected +OK for LIST, got: ${listResp}`);
    // Read the listing until dot
    const entries = await client.readMultiLine();
    assertEquals(entries.length, 2, "Expected 2 message entries from LIST");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("POP3Proxy: QUIT returns +OK and closes session", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3Stack(fake.port);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, stack.proxyPort, fake.port);

    await client.send("QUIT");
    const resp = await client.readLine();
    assert(resp?.startsWith("+OK"), `Expected +OK for QUIT, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("POP3Proxy: malformed USER (no server) returns -ERR", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3Stack(fake.port);
  const client = await connectPOP3(stack.proxyPort);
  try {
    const banner = await client.readLine();
    assert(banner?.startsWith("+OK"));

    await client.send("USER nocolon");
    const resp = await client.readLine();
    assert(resp?.startsWith("-ERR"), `Expected -ERR for malformed USER, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("POP3Proxy: unauthenticated command returns -ERR", async () => {
  const fake = FakePOP3Server.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3Stack(fake.port);
  const client = await connectPOP3(stack.proxyPort);
  try {
    const banner = await client.readLine();
    assert(banner?.startsWith("+OK"));

    // Send RETR without logging in first
    await client.send("RETR 1");
    const resp = await client.readLine();
    assert(resp?.startsWith("-ERR"), `Expected -ERR before auth, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});
