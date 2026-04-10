// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * tests/nntp_test.ts — End-to-end tests for NNTPProxy.
 *
 * Spins up a minimal fake NNTP server, boots the full module stack with
 * NNTPProxy on port 0, drives a real TCP client through the proxy, and
 * asserts that ARTICLE responses contain the injected X-Text-Classification
 * header.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/nntp_test.ts
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { NNTPProxy } from "../proxy/NNTPProxy.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Line reader
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
// Fake NNTP server
// ---------------------------------------------------------------------------

/**
 * Minimal NNTP server that serves a fixed set of articles.
 * Handles: GROUP, ARTICLE, HEAD, BODY, QUIT, and a bare LIST.
 */
class FakeNNTPServer {
  readonly port: number;
  #listener: Deno.Listener;
  #articles: Map<number, string>; // article number → raw RFC 2822 message

  private constructor(listener: Deno.Listener, articles: Map<number, string>) {
    this.#listener = listener;
    this.#articles = articles;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#acceptLoop();
  }

  static start(articles: Map<number, string>): FakeNNTPServer {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    return new FakeNNTPServer(listener, articles);
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
    const send = (s: string) => conn.write(enc.encode(s + "\r\n"));
    const read = makeTcpLineReader(conn);

    await send("200 fake.nntp.test NNTP service ready");

    try {
      while (true) {
        const raw = await read();
        if (raw === null) break;
        const line = raw.trimEnd();
        const upper = line.toUpperCase();

        if (upper.startsWith("GROUP ")) {
          const count = this.#articles.size;
          const nums = [...this.#articles.keys()];
          const lo = nums.length ? Math.min(...nums) : 0;
          const hi = nums.length ? Math.max(...nums) : 0;
          await send(`211 ${count} ${lo} ${hi} test.group`);

        } else if (upper.startsWith("ARTICLE") || upper.startsWith("ARTICLE ")) {
          const numStr = line.slice(7).trim();
          const num = numStr ? parseInt(numStr, 10) : 1;
          const body = this.#articles.get(num);
          if (!body) {
            await send("423 No such article");
          } else {
            await send(`220 ${num} <${num}@fake> article retrieved`);
            for (const msgLine of body.split("\r\n")) {
              await send(msgLine.startsWith(".") ? "." + msgLine : msgLine);
            }
            await send(".");
          }

        } else if (upper.startsWith("HEAD ")) {
          const num = parseInt(line.slice(5).trim(), 10);
          const body = this.#articles.get(num);
          if (!body) {
            await send("423 No such article");
          } else {
            // Send only the headers (up to the blank line)
            const headerEnd = body.indexOf("\r\n\r\n");
            const headers = headerEnd !== -1 ? body.slice(0, headerEnd) : body;
            await send(`221 ${num} <${num}@fake> head retrieved`);
            for (const msgLine of headers.split("\r\n")) {
              await send(msgLine.startsWith(".") ? "." + msgLine : msgLine);
            }
            await send(".");
          }

        } else if (upper.startsWith("BODY ")) {
          const num = parseInt(line.slice(5).trim(), 10);
          const body = this.#articles.get(num);
          if (!body) {
            await send("423 No such article");
          } else {
            const headerEnd = body.indexOf("\r\n\r\n");
            const bodyText = headerEnd !== -1 ? body.slice(headerEnd + 4) : body;
            await send(`222 ${num} <${num}@fake> body retrieved`);
            for (const msgLine of bodyText.split("\r\n")) {
              await send(msgLine.startsWith(".") ? "." + msgLine : msgLine);
            }
            await send(".");
          }

        } else if (upper === "LIST") {
          await send("215 list of newsgroups follows");
          await send("test.group 1 1 y");
          await send(".");

        } else if (upper === "QUIT") {
          await send("205 goodbye");
          break;

        } else {
          await send("500 unknown command");
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

interface NNTPStack {
  proxy: NNTPProxy;
  bayes: Bayes;
  session: string;
  proxyPort: number;
  cleanup: () => void;
}

async function makeNNTPStack(fakeServerPort: number): Promise<NNTPStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("nntp",      new NNTPProxy(),      4);

  const modules = ["config", "mq", "logger", "database", "classifier", "nntp"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("GLOBAL_user_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  config.parameter("logger_log_dir",   join(tmpDir, "logs"));
  config.parameter("nntp_port",        "0");
  config.parameter("nntp_server",      "127.0.0.1");
  config.parameter("nntp_server_port", String(fakeServerPort));

  for (const alias of modules) loader.getModule(alias).start();

  const proxy = loader.getModule("nntp") as NNTPProxy;
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
// NNTP client helper
// ---------------------------------------------------------------------------

interface NNTPClient {
  send: (s: string) => Promise<void>;
  readLine: () => Promise<string | null>;
  /** Read lines until bare "." terminator; returns lines without the dot. */
  readMultiLine: () => Promise<string[]>;
  close: () => void;
}

async function connectNNTP(port: number): Promise<NNTPClient> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const enc = new TextEncoder();
  const readLine = makeTcpLineReader(conn);
  return {
    send: (s: string) => conn.write(enc.encode(s + "\r\n")).then(() => {}),
    readLine,
    async readMultiLine(): Promise<string[]> {
      const lines: string[] = [];
      while (true) {
        const line = await readLine();
        if (line === null || line.trimEnd() === ".") break;
        lines.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return lines;
    },
    close() { try { conn.close(); } catch { /* ok */ } },
  };
}

// ---------------------------------------------------------------------------
// Fixture articles
// ---------------------------------------------------------------------------

const SPAM_ARTICLE = [
  "From: spammer@evil.com",
  "Newsgroups: test.group",
  "Subject: Buy cheap pills now FREE SHIPPING",
  "Message-ID: <1@fake>",
  "",
  "Click here to purchase discount pharmaceuticals at amazing prices.",
  "Limited time offer act now free shipping worldwide buy now.",
].join("\r\n");

const HAM_ARTICLE = [
  "From: alice@example.com",
  "Newsgroups: test.group",
  "Subject: Re: Meeting tomorrow",
  "Message-ID: <2@fake>",
  "",
  "Hi Bob, can we meet tomorrow at 10am to discuss the project?",
  "Let me know if that works for you. Thanks, Alice.",
].join("\r\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("NNTPProxy: proxy greeting starts with 200", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    const greeting = await client.readLine();
    assert(greeting?.startsWith("200"), `Expected 200 greeting, got: ${greeting}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: ARTICLE response contains X-Text-Classification header", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("GROUP test.group");
    const groupResp = await client.readLine();
    assert(groupResp?.startsWith("211"), `Expected 211 for GROUP, got: ${groupResp}`);

    await client.send("ARTICLE 1");
    const articleResp = await client.readLine();
    assert(articleResp?.startsWith("220"), `Expected 220 for ARTICLE, got: ${articleResp}`);

    const lines = await client.readMultiLine();
    const full = lines.join("\n");
    assert(
      full.includes("X-Text-Classification:"),
      `Expected X-Text-Classification in:\n${full}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: trained classification appears in ARTICLE header", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);

  // Train the classifier
  const parser = new MailParser();
  stack.bayes.createBucket(stack.session, "spam");
  stack.bayes.createBucket(stack.session, "inbox");
  for (let i = 0; i < 3; i++) {
    const spamFile = await Deno.makeTempFile({ suffix: ".eml" });
    const hamFile  = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(spamFile, SPAM_ARTICLE);
      await Deno.writeTextFile(hamFile,  HAM_ARTICLE);
      stack.bayes.trainMessage(stack.session, "spam",  parser.parseFile(spamFile));
      stack.bayes.trainMessage(stack.session, "inbox", parser.parseFile(hamFile));
    } finally {
      await Deno.remove(spamFile).catch(() => {});
      await Deno.remove(hamFile).catch(() => {});
    }
  }

  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("GROUP test.group");
    await client.readLine(); // 211

    await client.send("ARTICLE 1");
    const articleResp = await client.readLine();
    assert(articleResp?.startsWith("220"), `Expected 220, got: ${articleResp}`);

    const lines = await client.readMultiLine();
    const header = lines.find((l) => l.startsWith("X-Text-Classification:"));
    assert(header !== undefined, "X-Text-Classification header missing");
    assert(header!.includes("spam"), `Expected 'spam', got: ${header}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: HEAD response contains X-Text-Classification header", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("HEAD 1");
    const resp = await client.readLine();
    assert(resp?.startsWith("221"), `Expected 221 for HEAD, got: ${resp}`);

    const lines = await client.readMultiLine();
    assert(
      lines.some((l) => l.startsWith("X-Text-Classification:")),
      `Expected X-Text-Classification in HEAD response:\n${lines.join("\n")}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: BODY is relayed without modification", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("BODY 1");
    const resp = await client.readLine();
    assert(resp?.startsWith("222"), `Expected 222 for BODY, got: ${resp}`);

    const lines = await client.readMultiLine();
    assert(lines.some((l) => l.includes("Click here")), "Expected body content");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: LIST is relayed and returns newsgroup list", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("LIST");
    const resp = await client.readLine();
    assert(resp?.startsWith("215"), `Expected 215 for LIST, got: ${resp}`);

    const lines = await client.readMultiLine();
    assertEquals(lines.length, 1);
    assert(lines[0].includes("test.group"), "Expected newsgroup in LIST");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: QUIT returns 205", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("QUIT");
    const resp = await client.readLine();
    assert(resp?.startsWith("205"), `Expected 205 for QUIT, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: original article headers and body are preserved", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("ARTICLE 1");
    await client.readLine(); // 220

    const lines = await client.readMultiLine();
    const full = lines.join("\n");
    assert(full.includes("From: spammer@evil.com"), "From header should be preserved");
    assert(full.includes("Subject: Buy cheap pills"), "Subject should be preserved");
    assert(full.includes("Click here to purchase"), "Body should be preserved");
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});

Deno.test("NNTPProxy: nonexistent article returns 423", async () => {
  const fake = FakeNNTPServer.start(new Map([[1, SPAM_ARTICLE]]));
  const stack = await makeNNTPStack(fake.port);
  const client = await connectNNTP(stack.proxyPort);
  try {
    await client.readLine(); // greeting

    await client.send("ARTICLE 999");
    const resp = await client.readLine();
    assert(resp?.startsWith("423"), `Expected 423 for missing article, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
  }
});
