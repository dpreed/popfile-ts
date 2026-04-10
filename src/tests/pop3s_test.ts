/**
 * tests/pop3s_test.ts — End-to-end tests for POP3SProxy.
 *
 * Spins up a minimal TLS-enabled fake POP3 server using an embedded
 * self-signed certificate, boots the full module stack with POP3SProxy on
 * port 0 (configured to trust the test CA), then drives a plain-TCP client
 * through the proxy and asserts on the classified responses.
 *
 * The self-signed cert covers 127.0.0.1 (SAN IP) so Deno's TLS stack
 * accepts it when the custom CA is injected via pop3_tls_ca_cert.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/pop3s_test.ts
 */

import { assert } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { POP3SProxy } from "../proxy/POP3SProxy.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Embedded two-tier test PKI. Valid 10 years from 2026-04-09. For testing only.
//
// CA cert   → passed as caCerts to Deno.connectTls so the proxy trusts the server
// Srv cert  → presented by the fake TLS server (signed by the CA, CA:FALSE)
// Srv key   → private key for the server cert
//
// Rustls (Deno 2.x) rejects CA:TRUE certs as end-entity server certs, so a
// two-tier PKI is required. The CA cert itself is never used as the server cert.
// ---------------------------------------------------------------------------

/** CA certificate — trust anchor for connectTls caCerts. */
const TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUKzzlVPEpHHMDHJUvueBBfILiDXUwDQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAwwGVGVzdENBMB4XDTI2MDQwOTE5MTIxOVoXDTM2MDQwNjE5
MTIxOVowETEPMA0GA1UEAwwGVGVzdENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAsg0qWvNvf9j+yCwSEcE5N796cnkxFeG4YsiaoCwW3bOTTQjwKi3N
cl9wZ/t64GFWSJ/sPgvP75Q+9zDlgdFYM4+ylwb5Yf5An0yNy/1GBRYDIxl1zaTv
cQ7MyfuR6jqubx/TqTQFavoJO6egVmS2aebM6XaoNOqV+f11yQmzHB7TMv0Gpgxg
aFm94yMZWiAwMBKEdr4ihsbfdpcvdA0haxhBy8nxmN0QONrrK51MxNyI2ms2mc9c
YeF+9Or/RX3jOU7zc+O91dhYnQu7LyKJTeqLZbbaOhhR1ZU7d8VZ9GIFajprtXy+
ExBXnupCzrMx/u5pVVBwqRzxbufL+ZT1fQIDAQABo2MwYTAdBgNVHQ4EFgQU5va7
eipxKKd7VFhxu+ukONK8s9gwHwYDVR0jBBgwFoAU5va7eipxKKd7VFhxu+ukONK8
s9gwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQEL
BQADggEBAJT0z3EOmhpY8ATOWFUcZorBmsoO1l02orL2c/Pdi5+pOxyS2393X6Ut
0SABzY0JgIeMt6fBcnKfARanNvoS+YP+VIKNK5wsXsZj3DYpKJreEEDen7SuxcyV
/5Izkzcya6Wt+EUMJW8kxig5DHf9+PGmQxAwN4rNFSCEYGE4tPy3+rayZvMWbtyx
rBszi3dehHZO9Pzt3Zr1ac2A0XBwO8zd/YRaPoJqcG7/UcjWEsT4hTVYBlJcwG7Y
0c04zC9I76O9GAYZLb/aozu+XuyrNXQsMsgtd8FhP+vxjAh9FFx+onPW2q2rGQT8
7ZC73Au15ZzBLqq/woCttg/+Cxqas4s=
-----END CERTIFICATE-----`;

/** Server certificate signed by TEST_CA_CERT (CN=127.0.0.1, SAN IP:127.0.0.1, CA:FALSE). */
const TEST_SRV_CERT = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUBLwtqkGezOjhCfayqIyDMzMkg9gwDQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAwwGVGVzdENBMB4XDTI2MDQwOTE5MTIxOVoXDTM2MDQwNjE5
MTIxOVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAxx0FepwM5cVj1DXJQORqNWiNTRFO7zdqmaB3gf7dAtnm0Lxu
fuyi1hfABXl4aSwFnOrhhXOoeKDlBIKO4QVg+/Kj0pSEky2yNdIzHnR01UkiXucE
2RpsuRJ/FSbPsuD6AH1XzfXSEJ5wzw2AxIdBUgBmYpHWAvwRGWYN1cdMs0IVwwzu
BTjpjt6+dZmOC66Tyd6Iogc9Gxv9YbHZti+Olyzq0kczPCV6iDUpLBuG8VDF/Jqh
sa7ffLOx5LiJ2o9WL3rhklu3Of0cOOBIgBTLAECVIT/CxfNndsIL3xdLdlcYcORB
DmbmMTT1Ftia5ZntGCdP/NvVzfIrLjFg97Vs7QIDAQABo4GAMH4wDwYDVR0RBAgw
BocEfwAAATAJBgNVHRMEAjAAMAsGA1UdDwQEAwIFoDATBgNVHSUEDDAKBggrBgEF
BQcDATAdBgNVHQ4EFgQUQO/8iQc6GFtYXiFyePlMnpR/OpIwHwYDVR0jBBgwFoAU
5va7eipxKKd7VFhxu+ukONK8s9gwDQYJKoZIhvcNAQELBQADggEBAGMjvNjCFAPR
yxFxKsg+TTt0kT2XjfU8KVQI3lNITBSDDkcPD8VFlBti1YCAPw9jiQPAMQ+vbW9C
VzQ+C6e+ZZhoRCh+fP40Buj/8wHo10okmacOM3gn1aIWR0fNPRyZ1C/k+roHIbRm
AxfoBQZGCftPJza5kAf7PCVfM832P2ezMoFSCIIXVmi3pYVyjwFvKY6YxDm7g68W
g1+nJn2RVPlIrVuUPnULamfHEFofyGLI+og8rjG78S0MzNO2kS1PxAcTQiBtNLcc
UTX6142fXW+pEYW0ydA9H7G8huOMGoqSg6FMq1OQrPR5pfN0ZW63VIwSLBkKnweK
y0o2b5jxgeY=
-----END CERTIFICATE-----`;

/** Private key for TEST_SRV_CERT. */
const TEST_SRV_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDHHQV6nAzlxWPU
NclA5Go1aI1NEU7vN2qZoHeB/t0C2ebQvG5+7KLWF8AFeXhpLAWc6uGFc6h4oOUE
go7hBWD78qPSlISTLbI10jMedHTVSSJe5wTZGmy5En8VJs+y4PoAfVfN9dIQnnDP
DYDEh0FSAGZikdYC/BEZZg3Vx0yzQhXDDO4FOOmO3r51mY4LrpPJ3oiiBz0bG/1h
sdm2L46XLOrSRzM8JXqINSksG4bxUMX8mqGxrt98s7HkuInaj1YveuGSW7c5/Rw4
4EiAFMsAQJUhP8LF82d2wgvfF0t2Vxhw5EEOZuYxNPUW2Jrlme0YJ0/829XN8isu
MWD3tWztAgMBAAECggEAK2bmklbgstcnjxLYVyZTBmhPYKy0rY1BVdJ2KmZxK5Vu
7DIezdjsF8neh/L17cr0QEOsvAe9genkceq5lVA0V0cJMbZA/cn4riWvEeTlsLY7
4T7vPhm1+FORUv1+SaojpKat1I3QZ+H5ihCR8IThFqxSpQrQAR+L5KLrwh0q2Wnc
N43FoezqPK5IhjFcaOYNVolSpKgi94K1ic80UoUgVjyoNuI54Ilvcqd3gMEZtjFB
2Zc8O4jyc22LYbREboOVvcyVeeeGQ4/e+VEAvY1gmwD9gUIjgvl5DwDR/cNX44Y3
gQnlPPISkWm9gWa+y1SU2APTEpeT9ify/TN5QgugAQKBgQDvSCkASsBzvtYgPmIv
yd7/9UocFjTxj0qkxwUpuKeBe8ZyrwyRoy0Hmet9Q/MrNdrg70YvyOki62iDa4js
31ezV3o7X9AW3sPuJQTzWEp00d1yjwYBsalDFqM+4F/Iegi39yH8Fsah/GLhDqhu
39sBwcNhByAgD1gLPvABj2DQAQKBgQDVBmZbo4psIACjzFwaV/O36UilGlhmMy5T
FZy6I177ApAZVGc/f02WoqXZvjILeuT0cHjjlOb/MoW9SyDTmOXA+pCdn3AbV3Lf
p7VXNND5KMIxZVCZBDclYSKOHsd3iXG9875yipfzgK44o/uEygUOXGQA6JYFzJTa
hIpzyFTc7QKBgQC1xRJoh2ClTK4q9ljuRqMhu7tdlL0JV7nzbMCOThjpMxawniul
ItkdMh8DHLBH/fRU9U9TE4OPJFdTpkfw8UUVFvniyskv5m/eo76cAVEmZxqbYOzG
MqkLLtI5/Iamq5Wd8p2de8vO2ARhRRpMh78+GWyLc7dCw4U1nc0C0mFQAQKBgFS/
xA8nJBXaMYb48ZeFcC+1vrH4pjyalg515bFkCxB/t4ZsPttTMTIBqUvUUCKjFN1u
tZmNDs1ucyiY8AlepeE9jjU3TimCg/AYz5tPJuhJX+C49vS5aZsUZuP1uNOEudyh
UR5Opx84DZf5HUJ6AMLy3NJDthO+jWXWHyLrC2ANAoGBAKO1iadj0rsq2blKLoYL
J7Fs8n44/EvUqCdlBKOKEfC6FSbN7RVlhOpyoF6O14s9lxCpSBsZU9x1y3wpumQw
hGVo4l+Oqs+IDyq2aF8yEy7ZBcnKQRm9FN/oK8tjSd64Ags5s+DAt/PBP238KZwv
SisuokJzvg5gQ/5LW4PYhUdT
-----END PRIVATE KEY-----`;

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
// Fake POP3S (TLS) server
// ---------------------------------------------------------------------------

class FakePOP3SServer {
  readonly port: number;
  #listener: Deno.TlsListener;
  #messages: Map<number, string>;

  private constructor(listener: Deno.TlsListener, messages: Map<number, string>) {
    this.#listener = listener;
    this.#messages = messages;
    this.port = (listener.addr as Deno.NetAddr).port;
    this.#acceptLoop();
  }

  static start(messages: Map<number, string>): FakePOP3SServer {
    const listener = Deno.listenTls({
      hostname: "127.0.0.1",
      port: 0,
      cert: TEST_SRV_CERT,
      key: TEST_SRV_KEY,
    });
    return new FakePOP3SServer(listener, messages);
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

    await sendLine("+OK POP3S fake server ready");

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
// Test stack
// ---------------------------------------------------------------------------

interface POP3SStack {
  proxy: POP3SProxy;
  bayes: Bayes;
  session: string;
  proxyPort: number;
  cleanup: () => void;
}

async function makePOP3SStack(
  fakeServerPort: number,
  certFile: string,
): Promise<POP3SStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("pop3s",     new POP3SProxy(),     4);

  const modules = ["config", "mq", "logger", "database", "classifier", "pop3s"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",    tmpDir);
  config.parameter("config_root_dir",    tmpDir);
  config.parameter("GLOBAL_user_dir",    tmpDir);
  config.parameter("logger_log_level",   "0");
  config.parameter("logger_log_dir",     join(tmpDir, "logs"));
  config.parameter("pop3s_port",         "0");
  config.parameter("pop3s_upstream_port", String(fakeServerPort));
  // Trust our self-signed test CA
  config.parameter("pop3s_tls_ca_cert",  certFile);

  for (const alias of modules) loader.getModule(alias).start();

  const proxy = loader.getModule("pop3s") as POP3SProxy;
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
// POP3 client helper (plain TCP — proxy handles TLS to upstream)
// ---------------------------------------------------------------------------

interface POP3Client {
  send: (s: string) => Promise<void>;
  readLine: () => Promise<string | null>;
  readMultiLine: () => Promise<string[]>;
  close: () => void;
}

async function connectPOP3(port: number): Promise<POP3Client> {
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
        if (line === null || line === ".") break;
        lines.push(line.startsWith("..") ? line.slice(1) : line);
      }
      return lines;
    },
    close() { try { conn.close(); } catch { /* ok */ } },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
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

async function login(client: POP3Client, fakePort: number): Promise<void> {
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
// Cert/key written to tmpDir once per test
// ---------------------------------------------------------------------------

/** Write the CA cert to a temp file so the proxy can load it via pop3s_tls_ca_cert. */
async function writeCACert(dir: string): Promise<string> {
  const certFile = join(dir, "test-ca.crt");
  await Deno.writeTextFile(certFile, TEST_CA_CERT);
  return certFile;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("POP3SProxy: connects to TLS upstream and injects X-Text-Classification", async () => {
  const certDir = await Deno.makeTempDir();
  const caFile = await writeCACert(certDir);
  const fake = FakePOP3SServer.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3SStack(fake.port, caFile);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, fake.port);

    await client.send("RETR 1");
    const firstLine = await client.readLine();
    assert(firstLine?.startsWith("+OK"), `Expected +OK for RETR, got: ${firstLine}`);

    const bodyLines = await client.readMultiLine();
    const msg = bodyLines.join("\n");
    assert(
      msg.includes("X-Text-Classification:"),
      `Expected X-Text-Classification header in:\n${msg}`,
    );
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
    Deno.removeSync(certDir, { recursive: true });
  }
});

Deno.test("POP3SProxy: trained classification reflected in header over TLS upstream", async () => {
  const certDir = await Deno.makeTempDir();
  const caFile = await writeCACert(certDir);
  const fake = FakePOP3SServer.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3SStack(fake.port, caFile);

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

  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, fake.port);

    await client.send("RETR 1");
    const firstLine = await client.readLine();
    assert(firstLine?.startsWith("+OK"), `Expected +OK for RETR, got: ${firstLine}`);

    const bodyLines = await client.readMultiLine();
    const header = bodyLines.find((l) => l.startsWith("X-Text-Classification:"));
    assert(header !== undefined, "X-Text-Classification header missing");
    assert(header!.includes("spam"), `Expected 'spam' classification, got: ${header}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
    Deno.removeSync(certDir, { recursive: true });
  }
});

Deno.test("POP3SProxy: LIST relayed correctly over TLS upstream", async () => {
  const certDir = await Deno.makeTempDir();
  const caFile = await writeCACert(certDir);
  const fake = FakePOP3SServer.start(new Map([[1, SPAM_EML], [2, HAM_EML]]));
  const stack = await makePOP3SStack(fake.port, caFile);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, fake.port);

    await client.send("LIST");
    const listResp = await client.readLine();
    assert(listResp?.startsWith("+OK"), `Expected +OK for LIST, got: ${listResp}`);
    const entries = await client.readMultiLine();
    assert(entries.length === 2, `Expected 2 LIST entries, got ${entries.length}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
    Deno.removeSync(certDir, { recursive: true });
  }
});

Deno.test("POP3SProxy: QUIT returns +OK", async () => {
  const certDir = await Deno.makeTempDir();
  const caFile = await writeCACert(certDir);
  const fake = FakePOP3SServer.start(new Map([[1, SPAM_EML]]));
  const stack = await makePOP3SStack(fake.port, caFile);
  const client = await connectPOP3(stack.proxyPort);
  try {
    await login(client, fake.port);
    await client.send("QUIT");
    const resp = await client.readLine();
    assert(resp?.startsWith("+OK"), `Expected +OK for QUIT, got: ${resp}`);
  } finally {
    client.close();
    stack.cleanup();
    fake.close();
    Deno.removeSync(certDir, { recursive: true });
  }
});
