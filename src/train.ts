// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * train.ts — CLI tool to bulk-train .eml files into a bucket.
 *
 * Usage:
 *   deno task train <bucket> <path> [path2 ...]
 *
 * Each path may be a .eml file or a directory (scanned recursively for
 * *.eml files). The bucket must already exist in the database.
 *
 * Examples:
 *   deno task train spam ~/mail/spam/
 *   deno task train inbox msg1.eml msg2.eml
 */

import { Configuration } from "./core/Configuration.ts";
import { MessageQueue } from "./core/MessageQueue.ts";
import { Logger } from "./core/Logger.ts";
import { Database } from "./core/Database.ts";
import { Bayes } from "./classifier/Bayes.ts";
import { MailParser } from "./classifier/MailParser.ts";
import { Loader } from "./core/Loader.ts";
import { walk } from "@std/fs";

const [bucket, ...paths] = Deno.args;
if (!bucket || paths.length === 0) {
  console.error("Usage: train.ts <bucket> <file-or-dir> [file-or-dir ...]");
  Deno.exit(1);
}

// Collect all .eml files from the given paths
async function collectEmls(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(p);
    } catch {
      console.error(`Error: '${p}' does not exist`);
      continue;
    }
    if (stat.isFile) {
      files.push(p);
    } else if (stat.isDirectory) {
      for await (const entry of walk(p, { exts: [".eml"], includeDirs: false })) {
        files.push(entry.path);
      }
    }
  }
  return files;
}

// Boot minimal stack
const loader = new Loader();
loader.register("config", new Configuration(), 0);
loader.register("mq", new MessageQueue(), 0);
loader.register("logger", new Logger(), 1);
loader.register("database", new Database(), 2);
loader.register("classifier", new Bayes(), 3);

const config = loader.getModule("config") as Configuration;

const userDir = Deno.env.get("POPFILE_USER_DIR") ?? "./";
config.parameter("config_user_dir", userDir);
config.parameter("config_root_dir", userDir);
config.parameter("logger_log_level", "0");

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

// Ensure bucket exists
const existing = bayes.getBuckets(session);
if (!existing.includes(bucket)) {
  console.log(`Bucket '${bucket}' not found — creating it.`);
  bayes.createBucket(session, bucket);
}

const files = await collectEmls(paths);
if (files.length === 0) {
  console.error("No .eml files found.");
  Deno.exit(1);
}

console.log(`Training ${files.length} message(s) into '${bucket}'…`);

const parser = new MailParser();
let ok = 0;
let failed = 0;

for (const file of files) {
  try {
    const parsed = parser.parseFile(file);
    bayes.trainMessage(session, bucket, parsed);
    ok++;
    if (ok % 10 === 0 || ok === files.length) {
      Deno.stdout.writeSync(new TextEncoder().encode(`\r  ${ok}/${files.length}`));
    }
  } catch (e) {
    console.error(`\nError training '${file}': ${e}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} trained, ${failed} failed.`);

// Print updated word counts
const counts = bayes.getBuckets(session).map((b) => {
  const wc = bayes.getBucketWordCount(session, b);
  return `  ${b}: ${wc.toLocaleString()} words`;
});
console.log("Bucket word counts:\n" + counts.join("\n"));

bayes.releaseSessionKey(session);
for (const alias of [...modules].reverse()) loader.getModule(alias).stop();
