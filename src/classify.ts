// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * classify.ts — CLI tool to classify one or more .eml files.
 *
 * Mirrors bayes.pl from the original Perl source.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     src/classify.ts message1.eml [message2.eml ...]
 */

import { Configuration } from "./core/Configuration.ts";
import { MessageQueue } from "./core/MessageQueue.ts";
import { Logger } from "./core/Logger.ts";
import { Database } from "./core/Database.ts";
import { Bayes } from "./classifier/Bayes.ts";
import { Loader } from "./core/Loader.ts";

const files = Deno.args;
if (files.length === 0) {
  console.error("Usage: classify.ts <message.eml> [message2.eml ...]");
  Deno.exit(1);
}

// Boot a minimal stack (no proxies, no UI)
const loader = new Loader();
loader.register("config", new Configuration(), 0);
loader.register("mq", new MessageQueue(), 0);
loader.register("logger", new Logger(), 1);
loader.register("database", new Database(), 2);
loader.register("classifier", new Bayes(), 3);

// One-shot boot — initialize + start all modules, but don't enter service loop
const config = loader.getModule("config") as Configuration;

const userDir = Deno.env.get("POPFILE_USER_DIR") ?? "./";
config.parameter("config_user_dir", userDir);
config.parameter("config_root_dir", userDir);
config.parameter("logger_log_level", "0"); // quiet during classify

const modules = ["config", "mq", "logger", "database", "classifier"];

for (const alias of modules) loader.getModule(alias).initialize();

// Start config first so popfile.cfg is loaded, then re-apply user dir so any
// stale GLOBAL_user_dir in the cfg file cannot override the env var (or default).
loader.getModule("config").start();
config.parameter("GLOBAL_user_dir", userDir);
config.parameter("GLOBAL_root_dir", userDir);
for (const alias of modules.slice(1)) loader.getModule(alias).start();

const bayes = loader.getModule("classifier") as Bayes;
const session = bayes.getAdministratorSessionKey();

let exitCode = 0;
for (const file of files) {
  try {
    Deno.statSync(file); // throws if missing
  } catch {
    console.error(`Error: file '${file}' does not exist`);
    exitCode = 1;
    continue;
  }

  try {
    const result = bayes.classify(session, file);
    const scoreStr = [...result.scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, s]) => `  ${b}: ${(s * 100).toFixed(4)}%`)
      .join("\n");

    console.log(`'${file}' → '${result.bucket}'${result.magnetUsed ? " [magnet]" : ""}`);
    if (scoreStr) console.log(scoreStr);
  } catch (e) {
    console.error(`Error classifying '${file}': ${e}`);
    exitCode = 1;
  }
}

bayes.releaseSessionKey(session);

for (const alias of [...modules].reverse()) {
  loader.getModule(alias).stop();
}

Deno.exit(exitCode);
