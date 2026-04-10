// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * tests/smtp_test.ts — End-to-end tests for SMTPProxy.
 *
 * Spins up a minimal fake SMTP server, boots the full module stack with
 * SMTPProxy on port 0, drives a real TCP client through the proxy, and
 * asserts that the message forwarded to the fake server contains the
 * injected X-Text-Classification header.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/smtp_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { SMTPProxy } from "../proxy/SMTPProxy.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Line reader (shared)
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
// Fake SMTP server
// ---------------------------------------------------------------------------

/** Stores the last DATA payload received (raw, after dot-unstuffing). */
class FakeSMTPServer {
  readonly port: number;
  #listener: Deno.Listener;
  /** Last complete message body received via DATA, including headers. */
  lastReceived: string | null = null;

  private constructor(listener: Deno.Listener) {
    this.#listener = listener;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#acceptLoop();
  }

  static start(): FakeSMTPServer {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    return new FakeSMTPServer(listener);
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

    await sendLine("220 fake.smtp.test ESMTP");

    try {
      while (true) {
        const raw = await read();
        if (raw === null) break;
        const upper = raw.trimEnd().toUpperCase();

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          await sendLine("250-fake.smtp.test");
          await sendLine("250 OK");
        } else if (upper.startsWith("MAIL FROM")) {
          await sendLine("250 OK");
        } else if (upper.startsWith("RCPT TO")) {
          await sendLine("250 OK");
        } else if (upper === "DATA") {
          await sendLine("354 Start mail input; end with <CRLF>.<CRLF>");
          // Collect message until bare "."
          const lines: string[] = [];
          while (true) {
            const line = await read();
            if (line === null || line.trimEnd() === ".") break;
            // Dot-unstuffing
            lines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          this.lastReceived = lines.join("\r\n");
          await sendLine("250 OK: message accepted");
        } else if (upper === "QUIT") {
          await sendLine("221 Bye");
          break;
        } else if (upper === "RSET") {
          await sendLine("250 OK");
        } else {
          await sendLine("500 Unknown command");
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

interface SMTPStack {
  proxy: SMTPProxy;
  bayes: Bayes;
  session: string;
  proxyPort: number;
  cleanup: () => void;
}

async function makeSMTPStack(fakeServerPort: number): Promise<SMTPStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("smtp",      new SMTPProxy(),      4);

  const modules = ["config", "mq", "logger", "database", "classifier", "smtp"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("GLOBAL_user_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  config.parameter("logger_log_dir",   join(tmpDir, "logs"));
  config.parameter("smtp_port",        "0");
  config.parameter("smtp_server",      "127.0.0.1");
  config.parameter("smtp_server_port", String(fakeServerPort));

  for (const alias of modules) loader.getModule(alias).start();

  const proxy = loader.getModule("smtp") as SMTPProxy;
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
// Minimal SMTP client helper
// ---------------------------------------------------------------------------

interface SMTPClient {
  send: (s: string) => Promise<void>;
  readLine: () => Promise<string | null>;
  /** Read a full SMTP response (handles multi-line "XYZ-..." continuations). */
  readResponse: () => Promise<string[]>;
  close: () => void;
}

async function connectSMTP(port: number): Promise<SMTPClient> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const enc = new TextEncoder();
  const readLine = makeTcpLineReader(conn);
  return {
    send: (s: string) => conn.write(enc.encode(s + "\r\n")).then(() => {}),
    readLine,
    async readResponse(): Promise<string[]> {
      const lines: string[] = [];
      while (true) {
        const line = await readLine();
        if (line === null) break;
        lines.push(line);
        // "XYZ-text" = continuation; "XYZ text" = final
        if (line.length < 4 || line[3] !== "-") break;
      }
      return lines;
    },
    close() { try { conn.close(); } catch { /* ok */ } },
  };
}

// ---------------------------------------------------------------------------
// Fixture messages
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

/** Send a full SMTP transaction and return the DATA response lines. */
async function sendMessage(
  client: SMTPClient,
  message: string,
): Promise<string[]> {
  // EHLO
  await client.send("EHLO test.example");
  await client.readResponse();

  // MAIL FROM + RCPT TO
  await client.send("MAIL FROM:<sender@test.example>");
  await client.readResponse();
  await client.send("RCPT TO:<recipient@test.example>");
  await client.readResponse();

  // DATA
  await client.send("DATA");
  await client.readResponse(); // 354

  // Send message lines
  for (const line of message.split("\r\n")) {
    await client.send(line.startsWith(".") ? "." + line : line);
  }
  await client.send(".");

  return await client.readResponse(); // 250
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("SMTPProxy: forwarded DATA contains X-Text-Classification header", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);
  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting

    const dataResp = await sendMessage(client, SPAM_EML);
    assert(dataResp[0]?.startsWith("250"), `Expected 250 after DATA, got: ${dataResp[0]}`);

    assert(fake.lastReceived !== null, "Fake server should have received a message");
    assert(
      fake.lastReceived!.includes("X-Text-Classification:"),
      `Expected X-Text-Classification in:\n${fake.lastReceived}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("SMTPProxy: trained classification appears in forwarded header", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);

  // Train the classifier
  const parser = new MailParser();
  stack.bayes.createBucket(stack.session, "spam");
  stack.bayes.createBucket(stack.session, "inbox");
  for (let i = 0; i < 3; i++) {
    const spamFile = await Deno.makeTempFile({ suffix: ".eml" });
    const hamFile  = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(spamFile, SPAM_EML);
      await Deno.writeTextFile(hamFile,  HAM_EML);
      stack.bayes.trainMessage(stack.session, "spam",  parser.parseFile(spamFile));
      stack.bayes.trainMessage(stack.session, "inbox", parser.parseFile(hamFile));
    } finally {
      await Deno.remove(spamFile).catch(() => {});
      await Deno.remove(hamFile).catch(() => {});
    }
  }

  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting
    await sendMessage(client, SPAM_EML);

    const header = fake.lastReceived
      ?.split("\r\n")
      .find((l) => l.startsWith("X-Text-Classification:"));
    assert(header !== undefined, "X-Text-Classification header missing from forwarded message");
    assert(header!.includes("spam"), `Expected 'spam' classification, got: ${header}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("SMTPProxy: EHLO multi-line response is relayed to client", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);
  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting

    await client.send("EHLO test.example");
    const resp = await client.readResponse();
    assert(resp.length >= 1, "EHLO should return at least one line");
    assert(resp[resp.length - 1].startsWith("250"), "EHLO final line should start with 250");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("SMTPProxy: MAIL FROM and RCPT TO are relayed and return 250", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);
  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting
    await client.send("EHLO test.example");
    await client.readResponse();

    await client.send("MAIL FROM:<a@b.com>");
    const mailResp = await client.readResponse();
    assert(mailResp[0]?.startsWith("250"), `Expected 250 for MAIL FROM, got: ${mailResp[0]}`);

    await client.send("RCPT TO:<c@d.com>");
    const rcptResp = await client.readResponse();
    assert(rcptResp[0]?.startsWith("250"), `Expected 250 for RCPT TO, got: ${rcptResp[0]}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("SMTPProxy: QUIT returns 221", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);
  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting

    await client.send("QUIT");
    const resp = await client.readResponse();
    assert(resp[0]?.startsWith("221"), `Expected 221 for QUIT, got: ${resp[0]}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("SMTPProxy: original message body is preserved after header injection", async () => {
  const fake = FakeSMTPServer.start();
  const stack = await makeSMTPStack(fake.port);
  const client = await connectSMTP(stack.proxyPort);
  try {
    await client.readResponse(); // greeting
    await sendMessage(client, SPAM_EML);

    assert(fake.lastReceived !== null);
    // Original headers and body should still be present
    assert(fake.lastReceived!.includes("From: spammer@evil.com"), "From header should be preserved");
    assert(fake.lastReceived!.includes("Subject: Buy cheap pills now"), "Subject should be preserved");
    assert(fake.lastReceived!.includes("Click here to purchase"), "Body should be preserved");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});
