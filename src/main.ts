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
 *   POPFILE_USER_DIR    working directory for db, logs, messages (default: ./)
 *   POPFILE_POP3_PORT   POP3 proxy listen port (default: 110)
 *   POPFILE_UI_PORT     web UI listen port     (default: 8080)
 */

import { Loader } from "./core/Loader.ts";
import { MessageQueue } from "./core/MessageQueue.ts";
import { Configuration } from "./core/Configuration.ts";
import { Logger } from "./core/Logger.ts";
import { Database } from "./core/Database.ts";
import { Bayes } from "./classifier/Bayes.ts";
import { POP3Proxy } from "./proxy/POP3Proxy.ts";
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

const uiPort = Deno.env.get("POPFILE_UI_PORT");
if (uiPort) config.parameter("ui_port", uiPort);

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
// Level 4 — Proxies (depend on classifier)
// ---------------------------------------------------------------------------
loader.register("pop3", new POP3Proxy(), 4);

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
