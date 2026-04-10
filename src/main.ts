/**
 * main.ts — POPFile entry point for Deno.
 *
 * Wires together all modules in the correct run-level order and
 * starts the Loader boot sequence.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env src/main.ts
 *
 * Options (via env vars or popfile.cfg):
 *   POPFILE_USER_DIR           working directory for db, logs, messages (default: ./)
 *   POPFILE_POP3_PORT          POP3 proxy listen port  (default: 1110)
 *   POPFILE_POP3S_PORT         POP3S proxy listen port (default: 1995)
 *   POPFILE_UI_PORT            web UI listen port      (default: 8080)
 *   POPFILE_SMTP_SERVER        SMTP upstream hostname  (required to enable SMTP proxy)
 *   POPFILE_SMTP_SERVER_PORT   SMTP upstream port      (default: 25)
 *   POPFILE_SMTP_TLS           SMTP upstream TLS: 0 or 1 (default: 0)
 *   POPFILE_SMTP_PORT          SMTP proxy listen port  (default: 1025)
 *   POPFILE_NNTP_SERVER        NNTP upstream hostname  (required to enable NNTP proxy)
 *   POPFILE_NNTP_SERVER_PORT   NNTP upstream port      (default: 119)
 *   POPFILE_NNTP_TLS           NNTP upstream TLS: 0 or 1 (default: 0)
 *   POPFILE_NNTP_PORT          NNTP proxy listen port  (default: 1119)
 *   POPFILE_IMAP_SERVER        IMAP hostname (required to enable IMAP service)
 *   POPFILE_IMAP_PORT          IMAP port (default: 143; use 993 with TLS)
 *   POPFILE_IMAP_TLS           use TLS: 0 or 1 (default: 0)
 *   POPFILE_IMAP_USERNAME      IMAP login username
 *   POPFILE_IMAP_PASSWORD      IMAP login password
 *   POPFILE_IMAP_WATCH_FOLDER  folder to monitor (default: INBOX)
 *   POPFILE_IMAP_MOVE          move to bucket folders: 0 or 1 (default: 1)
 *   POPFILE_IMAP_FOLDER_PREFIX prefix for bucket folder names (default: "")
 *   POPFILE_IMAP_INTERVAL      seconds between checks (default: 60)
 */

import { Loader } from "./core/Loader.ts";
import { MessageQueue } from "./core/MessageQueue.ts";
import { Configuration } from "./core/Configuration.ts";
import { Logger } from "./core/Logger.ts";
import { Database } from "./core/Database.ts";
import { Bayes } from "./classifier/Bayes.ts";
import { POP3Proxy } from "./proxy/POP3Proxy.ts";
import { POP3SProxy } from "./proxy/POP3SProxy.ts";
import { SMTPProxy } from "./proxy/SMTPProxy.ts";
import { NNTPProxy } from "./proxy/NNTPProxy.ts";
import { IMAPService } from "./services/IMAPService.ts";
import { UIServer } from "./ui/UIServer.ts";

const loader = new Loader();

// ---------------------------------------------------------------------------
// Level 0 — Configuration and message queue must come first
// ---------------------------------------------------------------------------
const config = new Configuration();
const mq = new MessageQueue();

// Apply any environment variable overrides before modules initialize
const userDir = Deno.env.get("POPFILE_USER_DIR") ?? "./";
config.parameter("config_user_dir", userDir);
config.parameter("config_root_dir", userDir);

const pop3Port = Deno.env.get("POPFILE_POP3_PORT");
if (pop3Port) config.parameter("pop3_port", pop3Port);

const pop3sPort = Deno.env.get("POPFILE_POP3S_PORT");
if (pop3sPort) config.parameter("pop3s_port", pop3sPort);

const uiPort = Deno.env.get("POPFILE_UI_PORT");
if (uiPort) config.parameter("ui_port", uiPort);

// Proxy and service env vars
const envMap: Array<[string, string]> = [
  // SMTP proxy
  ["POPFILE_SMTP_SERVER",        "smtp_server"],
  ["POPFILE_SMTP_SERVER_PORT",   "smtp_server_port"],
  ["POPFILE_SMTP_TLS",           "smtp_tls"],
  ["POPFILE_SMTP_PORT",          "smtp_port"],
  // NNTP proxy
  ["POPFILE_NNTP_SERVER",        "nntp_server"],
  ["POPFILE_NNTP_SERVER_PORT",   "nntp_server_port"],
  ["POPFILE_NNTP_TLS",           "nntp_tls"],
  ["POPFILE_NNTP_PORT",          "nntp_port"],
  // IMAP service
  ["POPFILE_IMAP_SERVER",        "imap_server"],
  ["POPFILE_IMAP_PORT",          "imap_port"],
  ["POPFILE_IMAP_TLS",           "imap_tls"],
  ["POPFILE_IMAP_USERNAME",      "imap_username"],
  ["POPFILE_IMAP_PASSWORD",      "imap_password"],
  ["POPFILE_IMAP_WATCH_FOLDER",  "imap_watch_folder"],
  ["POPFILE_IMAP_MOVE",          "imap_move"],
  ["POPFILE_IMAP_FOLDER_PREFIX", "imap_folder_prefix"],
  ["POPFILE_IMAP_INTERVAL",      "imap_interval"],
];
for (const [envKey, cfgKey] of envMap) {
  const val = Deno.env.get(envKey);
  if (val !== undefined) config.parameter(cfgKey, val);
}

loader.register("config", config, 0);
loader.register("mq", mq, 0);

// ---------------------------------------------------------------------------
// Level 1 — Logging
// ---------------------------------------------------------------------------
loader.register("logger", new Logger(), 1);

// ---------------------------------------------------------------------------
// Level 2 — Database
// ---------------------------------------------------------------------------
loader.register("database", new Database(), 2);

// ---------------------------------------------------------------------------
// Level 3 — Classifier (depends on database)
// ---------------------------------------------------------------------------
loader.register("classifier", new Bayes(), 3);

// ---------------------------------------------------------------------------
// Level 4 — Proxies and services (depend on classifier)
// ---------------------------------------------------------------------------
loader.register("pop3", new POP3Proxy(), 4);
loader.register("pop3s", new POP3SProxy(), 4);
loader.register("smtp", new SMTPProxy(), 4);
loader.register("nntp", new NNTPProxy(), 4);
loader.register("imap", new IMAPService(), 4);

// ---------------------------------------------------------------------------
// Level 5 — UI (depends on classifier)
// ---------------------------------------------------------------------------
loader.register("ui", new UIServer(), 5);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await loader.boot();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  Deno.exit(1);
});
