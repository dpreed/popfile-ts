// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * NNTPProxy.ts — NNTP proxy with inline Bayes classification.
 *
 * Mirrors Proxy::NNTP. Listens on a local port and relays all NNTP
 * commands to a pre-configured upstream news server. The ARTICLE (and
 * HEAD/BODY) commands are intercepted: when the server returns a
 * multi-line article response the proxy buffers it, classifies it, injects
 * an X-Text-Classification header into the article headers, then forwards
 * the tagged article to the client.
 *
 * Config keys (prefix "nntp_"):
 *   port          Local listen port (default 1119)
 *   server        Upstream NNTP hostname (required; empty = disabled)
 *   server_port   Upstream port (default 119)
 *   tls           Connect to upstream with TLS (default 0)
 *   local         Bind to 127.0.0.1 only (default 1)
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes } from "../classifier/Bayes.ts";

const EOL = "\r\n";

export class NNTPProxy extends Module {
  #listener: Deno.Listener | null = null;
  #session = "";

  constructor() {
    super();
    this.name_ = "nntp";
  }

  override initialize(): LifecycleResult {
    this.config_("port", "1119");
    this.config_("server", "");
    this.config_("server_port", "119");
    this.config_("tls", "0");
    this.config_("local", "1");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    if (!this.config_("server")) {
      this.log_(0, "NNTP server not configured — proxy disabled");
      return LifecycleResult.Skip;
    }

    const port = parseInt(this.config_("port"), 10);
    const hostname = this.config_("local") === "1" ? "127.0.0.1" : "0.0.0.0";

    try {
      this.#listener = Deno.listen({ hostname, port });
      this.log_(0, `NNTP proxy listening on ${hostname}:${port}`);
    } catch (e) {
      this.log_(0, `NNTP proxy: cannot bind to ${hostname}:${port}: ${e}`);
      return LifecycleResult.Fatal;
    }

    const bayes = this.getModule_<Bayes>("classifier");
    this.#session = bayes.getAdministratorSessionKey();

    this.#acceptLoop();
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#listener?.close();
    this.#listener = null;
    super.stop();
  }

  /** Returns the actual bound port (useful when configured with port 0). */
  getListenPort(): number {
    const addr = this.#listener?.addr as Deno.NetAddr | undefined;
    return addr?.port ?? parseInt(this.config_("port"), 10);
  }

  override service(): boolean {
    return this.alive_;
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  async #acceptLoop(): Promise<void> {
    if (!this.#listener) return;
    for await (const conn of this.#listener) {
      this.#handleClient(conn).catch((e) =>
        this.log_(0, `NNTP client error: ${e}`)
      );
    }
  }

  async #handleClient(client: Deno.Conn): Promise<void> {
    this.log_(1, "New NNTP client connection");
    await this.#nntpSession(client);
    try { client.close(); } catch { /* already closed */ }
  }

  async #nntpSession(client: Deno.Conn): Promise<void> {
    const server     = this.config_("server");
    const serverPort = parseInt(this.config_("server_port"), 10);
    const useTls     = this.config_("tls") === "1";

    const send = async (line: string) => {
      await client.write(new TextEncoder().encode(line + EOL));
    };

    // Connect to upstream server
    let upstream: Deno.Conn;
    try {
      upstream = useTls
        ? await Deno.connectTls({ hostname: server, port: serverPort })
        : await Deno.connect({ hostname: server, port: serverPort });
    } catch (e) {
      await send(`400 Cannot connect to upstream server: ${e}`);
      return;
    }

    const clientReader   = this.#makeLineReader(client);
    const upstreamReader = this.#makeLineReader(upstream);

    const relay = async (line: string) => {
      await upstream.write(new TextEncoder().encode(line + EOL));
    };

    const bayes = this.getModule_<Bayes>("classifier");

    try {
      // Forward the upstream greeting to the client
      const greeting = await upstreamReader();
      if (!greeting) {
        await send("400 Upstream server unavailable");
        return;
      }
      await send(greeting.trim());

      // Main relay loop
      while (true) {
        const line = await clientReader();
        if (line === null) break;

        const cmd      = line.trimEnd();
        const upperCmd = cmd.toUpperCase();

        // ----------------------------------------------------------------
        // ARTICLE / HEAD / BODY — intercept for classification
        // ----------------------------------------------------------------
        if (
          upperCmd === "ARTICLE" ||
          upperCmd.startsWith("ARTICLE ") ||
          upperCmd === "HEAD" ||
          upperCmd.startsWith("HEAD ")
        ) {
          await relay(cmd);
          const resp = await upstreamReader();
          if (!resp) break;

          const code = parseInt(resp.trim().slice(0, 3), 10);
          // 220 = article follows, 221 = head follows, 222 = body follows
          if (code === 220 || code === 221) {
            await send(resp.trim());
            await this.#relayAndClassify(client, bayes, upstreamReader, code === 220);
          } else {
            await send(resp.trim());
          }
          continue;
        }

        if (upperCmd === "BODY" || upperCmd.startsWith("BODY ")) {
          await relay(cmd);
          const resp = await upstreamReader();
          if (!resp) break;
          const code = parseInt(resp.trim().slice(0, 3), 10);
          if (code === 222) {
            await send(resp.trim());
            // Body-only: no headers to inject, just relay
            await this.#relayUntilDot(client, upstreamReader);
          } else {
            await send(resp.trim());
          }
          continue;
        }

        // ----------------------------------------------------------------
        // QUIT
        // ----------------------------------------------------------------
        if (upperCmd === "QUIT") {
          await relay("QUIT");
          const quitResp = await upstreamReader();
          await send(quitResp?.trim() ?? "205 Goodbye");
          break;
        }

        // ----------------------------------------------------------------
        // All other commands — relay verbatim
        // ----------------------------------------------------------------
        await relay(cmd);

        // Some NNTP responses are multi-line (LIST, NEWSGROUPS, OVER, etc.)
        // We relay lines until we see a final response:
        //   - Single-line: "NNN text"
        //   - Multi-line: "NNN text" then lines then "."
        const firstResp = await upstreamReader();
        if (firstResp === null) break;
        const firstCode = parseInt(firstResp.trim().slice(0, 3), 10);
        await send(firstResp.trim());

        // Multi-line responses have codes in range 215, 231, 282..283
        if (this.#isMultiLineResponse(firstCode)) {
          await this.#relayUntilDot(client, upstreamReader);
        }
      }
    } finally {
      try { upstream.close(); } catch { /* ok */ }
    }
  }

  /** Returns true if the NNTP response code introduces a multi-line body. */
  #isMultiLineResponse(code: number): boolean {
    // 100 = help, 101 = capabilities, 215 = list, 220/221/222/223 = article/head/body/stat,
    // 224 = overview, 225 = hdr, 230 = new articles, 231 = new newsgroups,
    // 281 = auth accepted with more data, 282 = gzip data
    return [100, 101, 215, 224, 225, 230, 231].includes(code);
  }

  async #relayAndClassify(
    client: Deno.Conn,
    bayes: Bayes,
    readLine: () => Promise<string | null>,
    includesBody: boolean,
  ): Promise<void> {
    const enc = new TextEncoder();

    // Buffer the article (headers + possibly body)
    const lines: string[] = [];
    while (true) {
      const line = await readLine();
      if (line === null || line.trimEnd() === ".") break;
      // Dot-unstuffing
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }

    const rawMessage = lines.join("\r\n");

    // If this is an ARTICLE response (has headers + body), classify it
    let classification = "unclassified";
    if (includesBody) {
      const tmp = await Deno.makeTempFile({ suffix: ".eml" });
      try {
        await Deno.writeTextFile(tmp, rawMessage);
        const result = bayes.classify(this.#session, tmp);
        classification = result.bucket;
        this.log_(1, `NNTP article classified as '${classification}'`);
      } catch (e) {
        this.log_(0, `NNTP classification error: ${e}`);
      } finally {
        await Deno.remove(tmp).catch(() => {});
      }
    }

    // Inject X-Text-Classification header into the article headers
    const headerEnd = rawMessage.indexOf("\r\n\r\n");
    let output: string;
    if (includesBody && headerEnd !== -1) {
      output =
        rawMessage.slice(0, headerEnd) +
        `\r\nX-Text-Classification: ${classification}` +
        rawMessage.slice(headerEnd);
    } else if (includesBody && headerEnd === -1) {
      // No body separator — inject at end of headers
      output = rawMessage + `\r\nX-Text-Classification: ${classification}`;
    } else {
      // HEAD only — inject at end
      output = rawMessage + `\r\nX-Text-Classification: unclassified`;
    }

    // Send to client with dot-stuffing
    for (const outLine of output.split("\r\n")) {
      const stuffed = outLine.startsWith(".") ? "." + outLine : outLine;
      await client.write(enc.encode(stuffed + EOL));
    }
    await client.write(enc.encode("." + EOL));
  }

  async #relayUntilDot(
    client: Deno.Conn,
    readLine: () => Promise<string | null>,
  ): Promise<void> {
    const enc = new TextEncoder();
    while (true) {
      const line = await readLine();
      if (line === null || line.trimEnd() === ".") {
        await client.write(enc.encode("." + EOL));
        break;
      }
      await client.write(enc.encode(line.trimEnd() + EOL));
    }
  }

  #makeLineReader(conn: Deno.Conn): () => Promise<string | null> {
    const buf = new Uint8Array(4096);
    let leftover = "";
    return async (): Promise<string | null> => {
      while (true) {
        const nl = leftover.indexOf("\n");
        if (nl !== -1) {
          const line = leftover.slice(0, nl + 1);
          leftover = leftover.slice(nl + 1);
          return line.replace(/\r?\n$/, "");
        }
        let n: number | null;
        try { n = await conn.read(buf); } catch { return null; }
        if (n === null || n === 0) return leftover.length > 0 ? leftover : null;
        leftover += new TextDecoder().decode(buf.slice(0, n));
      }
    };
  }
}
