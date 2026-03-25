/**
 * POP3Proxy.ts — POP3 proxy with inline Bayes classification.
 *
 * Mirrors Proxy::POP3. Listens on a local port; for each incoming
 * client connection it:
 *   1. Intercepts the USER command to extract the real server/port from
 *      the username (format: user:realserver:port  or  user@realserver)
 *   2. Opens a connection to the real POP3 server
 *   3. Relays commands, intercepting RETR and TOP to classify each
 *      message and insert an X-Text-Classification header
 *   4. Relays the (tagged) message back to the client
 *
 * Deno's async TCP API replaces Perl's fork-per-connection model.
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";

const EOL = "\r\n";

export class POP3Proxy extends Module {
  #listener: Deno.Listener | null = null;
  #adminSession = "";

  constructor() {
    super();
    this.name_ = "pop3";
  }

  override initialize(): LifecycleResult {
    this.config_("port", "1110");
    this.config_("secure", "0");
    this.config_("local", "1");
    this.config_("separator", ":");
    this.config_("welcome_string", "POP3 POPFile proxy ready");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    const port = parseInt(this.config_("port"), 10);
    const hostname = this.config_("local") === "1" ? "127.0.0.1" : "0.0.0.0";

    try {
      this.#listener = Deno.listen({ hostname, port });
      this.log_(0, `POP3 proxy listening on ${hostname}:${port}`);
    } catch (e) {
      this.log_(0, `POP3 proxy: cannot bind to ${hostname}:${port}: ${e}`);
      return LifecycleResult.Fatal;
    }

    const bayes = this.getModule_<Bayes>("classifier");
    this.#adminSession = bayes.getAdministratorSessionKey();

    // Accept connections asynchronously (non-blocking relative to service())
    this.#acceptLoop();
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#listener?.close();
    this.#listener = null;
    super.stop();
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
        this.log_(0, `POP3 client error: ${e}`)
      );
    }
  }

  async #handleClient(client: Deno.Conn): Promise<void> {
    this.log_(1, "New POP3 client connection");
    const clientWriter = new WritableStreamDefaultWriter(
      client.writable.getWriter().releaseLock() as unknown as WritableStream
    );
    // Use a simpler approach with raw read/write
    await this.#pop3Session(client);
    try { client.close(); } catch { /* already closed */ }
  }

  async #pop3Session(client: Deno.Conn): Promise<void> {
    const send = async (line: string) => {
      await client.write(new TextEncoder().encode(line + EOL));
    };

    const readLine = this.#makeLineReader(client);

    // Greet client
    await send(`+OK ${this.config_("welcome_string")}`);

    let mail: Deno.Conn | null = null;
    const sep = this.config_("separator");
    let authenticated = false;
    const bayes = this.getModule_<Bayes>("classifier");

    try {
      while (true) {
        const line = await readLine();
        if (line === null) break;

        const cmd = line.trim();
        const upperCmd = cmd.toUpperCase();

        if (upperCmd.startsWith("QUIT")) {
          await send("+OK Goodbye");
          break;
        }

        if (upperCmd.startsWith("USER ")) {
          // Parse username: user<sep>host<sep>port or user<sep>host
          const token = cmd.slice(5).trim();
          const parts = token.split(sep);
          if (parts.length < 2) {
            await send("-ERR Username format: user" + sep + "server[" + sep + "port]");
            continue;
          }
          const [user, host, portStr] = parts;
          const port = portStr ? parseInt(portStr, 10) : 110;

          // Connect to real server
          try {
            mail = await Deno.connect({ hostname: host, port });
            // Read server banner
            const serverReader = this.#makeLineReader(mail);
            const banner = await serverReader();
            if (!banner?.startsWith("+OK")) {
              await send("-ERR Cannot connect to real server");
              mail.close(); mail = null; continue;
            }
            // Forward USER to real server
            await mail.write(new TextEncoder().encode(`USER ${user}${EOL}`));
            const userResp = await serverReader();
            await send(userResp?.trim() ?? "-ERR");
          } catch (e) {
            await send(`-ERR Cannot connect: ${e}`);
            mail = null;
          }
          continue;
        }

        if (upperCmd.startsWith("PASS ") && mail) {
          const passLine = cmd + EOL;
          await mail.write(new TextEncoder().encode(passLine));
          const serverReader = this.#makeLineReader(mail);
          const resp = await serverReader();
          await send(resp?.trim() ?? "-ERR");
          authenticated = resp?.startsWith("+OK") ?? false;
          continue;
        }

        // Relay other commands to the real server
        if (mail && authenticated) {
          await mail.write(new TextEncoder().encode(cmd + EOL));
          const serverReader = this.#makeLineReader(mail);

          if (upperCmd.startsWith("RETR ") || upperCmd.startsWith("TOP ")) {
            // Intercept message for classification
            await this.#relayAndClassify(mail, client, bayes, send, serverReader);
          } else {
            // Simple single-line or multi-line relay
            const resp = await serverReader();
            if (resp === null) break;
            await send(resp.trim());

            if (resp.startsWith("+OK") && (upperCmd === "LIST" || upperCmd === "UIDL")) {
              // Relay multi-line response until dot
              await this.#relayUntilDot(mail, client, serverReader);
            }
          }
        } else {
          await send("-ERR Not authenticated");
        }
      }
    } finally {
      try { mail?.close(); } catch { /* ok */ }
    }
  }

  async #relayAndClassify(
    _mail: Deno.Conn,
    client: Deno.Conn,
    bayes: Bayes,
    send: (l: string) => Promise<void>,
    readLine: () => Promise<string | null>,
  ): Promise<void> {
    const firstLine = await readLine();
    if (!firstLine?.startsWith("+OK")) {
      await send(firstLine?.trim() ?? "-ERR");
      return;
    }
    await send(firstLine.trim());

    // Buffer the message
    const lines: string[] = [];
    while (true) {
      const line = await readLine();
      if (line === null || line.trim() === ".") break;
      lines.push(line.trimEnd());
    }

    const rawMessage = lines.join("\r\n");

    // Write to temp file for parser
    const tmpPath = await Deno.makeTempFile({ suffix: ".eml" });
    try {
      await Deno.writeTextFile(tmpPath, rawMessage);
      const parser = new MailParser();
      const parsed = parser.parseFile(tmpPath);
      const result = bayes.classifyParsed(
        (bayes as unknown as { _adminUserId(): number })._adminUserId?.() ?? 1,
        parsed
      );
      const classification = result.bucket;

      // Inject X-Text-Classification header into message
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

      // Send modified message to client
      const enc = new TextEncoder();
      for (const outLine of output.split("\r\n")) {
        await client.write(enc.encode(outLine + EOL));
      }
      await client.write(enc.encode("." + EOL));
    } finally {
      await Deno.remove(tmpPath).catch(() => {});
    }
  }

  async #relayUntilDot(
    _mail: Deno.Conn,
    client: Deno.Conn,
    readLine: () => Promise<string | null>,
  ): Promise<void> {
    const enc = new TextEncoder();
    while (true) {
      const line = await readLine();
      if (line === null || line.trim() === ".") {
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
          return line;
        }
        let n: number | null;
        try { n = await conn.read(buf); } catch { return null; }
        if (n === null || n === 0) return leftover.length > 0 ? leftover : null;
        leftover += new TextDecoder().decode(buf.slice(0, n));
      }
    };
  }
}
