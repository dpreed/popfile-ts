// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * SMTPProxy.ts — SMTP proxy with inline Bayes classification.
 *
 * Mirrors Proxy::SMTP. Listens on a local port and relays all SMTP
 * commands to a pre-configured upstream server. The DATA command is
 * intercepted: the message is buffered, classified, tagged with an
 * X-Text-Classification header, then forwarded to the upstream.
 *
 * All other commands (EHLO, MAIL FROM, RCPT TO, AUTH, RSET, …) are
 * relayed verbatim, including multi-line EHLO responses.
 *
 * Config keys (prefix "smtp_"):
 *   port          Local listen port (default 1025)
 *   server        Upstream SMTP hostname (required; empty = disabled)
 *   server_port   Upstream port (default 25)
 *   tls           Connect to upstream with TLS (default 0)
 *   local         Bind to 127.0.0.1 only (default 1)
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes } from "../classifier/Bayes.ts";

const EOL = "\r\n";

export class SMTPProxy extends Module {
  #listener: Deno.Listener | null = null;
  #session = "";

  constructor() {
    super();
    this.name_ = "smtp";
  }

  override initialize(): LifecycleResult {
    this.config_("port", "1025");
    this.config_("server", "");
    this.config_("server_port", "25");
    this.config_("tls", "0");
    this.config_("local", "1");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    if (!this.config_("server")) {
      this.log_(0, "SMTP server not configured — proxy disabled");
      return LifecycleResult.Skip;
    }

    const port = parseInt(this.config_("port"), 10);
    const hostname = this.config_("local") === "1" ? "127.0.0.1" : "0.0.0.0";

    try {
      this.#listener = Deno.listen({ hostname, port });
      this.log_(0, `SMTP proxy listening on ${hostname}:${port}`);
    } catch (e) {
      this.log_(0, `SMTP proxy: cannot bind to ${hostname}:${port}: ${e}`);
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
        this.log_(0, `SMTP client error: ${e}`)
      );
    }
  }

  async #handleClient(client: Deno.Conn): Promise<void> {
    this.log_(1, "New SMTP client connection");
    await this.#smtpSession(client);
    try { client.close(); } catch { /* already closed */ }
  }

  async #smtpSession(client: Deno.Conn): Promise<void> {
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
      await send(`421 Cannot connect to upstream server: ${e}`);
      return;
    }

    const clientReader   = this.#makeLineReader(client);
    const upstreamReader = this.#makeLineReader(upstream);

    const relay = async (line: string) => {
      await upstream.write(new TextEncoder().encode(line + EOL));
    };

    try {
      // Forward the upstream greeting to the client
      const greeting = await upstreamReader();
      if (!greeting?.startsWith("2")) {
        await send("421 Upstream server unavailable");
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
        // DATA — buffer, classify, inject header, forward
        // ----------------------------------------------------------------
        if (upperCmd === "DATA") {
          await relay("DATA");
          const dataResp = await upstreamReader();
          if (!dataResp?.startsWith("354")) {
            await send(dataResp?.trim() ?? "554 Upstream rejected DATA");
            continue;
          }
          await send("354 Start mail input; end with <CRLF>.<CRLF>");

          // Collect message lines from client (dot-unstuffing)
          const msgLines: string[] = [];
          while (true) {
            const msgLine = await clientReader();
            if (msgLine === null) break;
            if (msgLine.trimEnd() === ".") break;
            // RFC 5321 dot-unstuffing: leading ".." → "."
            msgLines.push(msgLine.startsWith("..") ? msgLine.slice(1) : msgLine);
          }

          const rawMessage = msgLines.join("\r\n");

          // Classify
          let classification = "unclassified";
          const tmp = await Deno.makeTempFile({ suffix: ".eml" });
          try {
            await Deno.writeTextFile(tmp, rawMessage);
            const bayes = this.getModule_<Bayes>("classifier");
            const result = bayes.classify(this.#session, tmp);
            classification = result.bucket;
            this.log_(1, `SMTP message classified as '${classification}'`);
          } catch (e) {
            this.log_(0, `SMTP classification error: ${e}`);
          } finally {
            await Deno.remove(tmp).catch(() => {});
          }

          // Inject X-Text-Classification into headers
          const headerEnd = rawMessage.indexOf("\r\n\r\n");
          let output: string;
          if (headerEnd !== -1) {
            output =
              rawMessage.slice(0, headerEnd) +
              `\r\nX-Text-Classification: ${classification}` +
              rawMessage.slice(headerEnd);
          } else {
            output = `X-Text-Classification: ${classification}\r\n\r\n${rawMessage}`;
          }

          // Forward to upstream with dot-stuffing
          const enc = new TextEncoder();
          for (const outLine of output.split("\r\n")) {
            const stuffed = outLine.startsWith(".") ? "." + outLine : outLine;
            await upstream.write(enc.encode(stuffed + EOL));
          }
          await upstream.write(enc.encode("." + EOL));

          // Relay upstream acceptance response
          const okResp = await upstreamReader();
          await send(okResp?.trim() ?? "250 OK");
          continue;
        }

        // ----------------------------------------------------------------
        // QUIT
        // ----------------------------------------------------------------
        if (upperCmd === "QUIT") {
          await relay("QUIT");
          const quitResp = await upstreamReader();
          await send(quitResp?.trim() ?? "221 Bye");
          break;
        }

        // ----------------------------------------------------------------
        // All other commands — relay verbatim, forward multi-line response
        // ----------------------------------------------------------------
        await relay(cmd);
        while (true) {
          const resp = await upstreamReader();
          if (resp === null) break;
          await send(resp.trim());
          // Multi-line: "XYZ-..." = more lines; "XYZ ..." = final
          if (resp.length >= 4 && resp[3] === "-") continue;
          break;
        }
      }
    } finally {
      try { upstream.close(); } catch { /* ok */ }
    }
  }

  // -------------------------------------------------------------------------
  // Line reader (buffered, handles partial reads)
  // -------------------------------------------------------------------------

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
