// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * Configuration.ts — Persistent key-value configuration store.
 *
 * Mirrors POPFile::Configuration. Parameters are keyed as
 * "<module>_<name>" (e.g. "pop3_port", "GLOBAL_timeout"). Values are
 * stored in popfile.cfg (INI-style) and flushed to disk hourly via
 * the TICKD message, and on clean shutdown.
 */

import { Module, LifecycleResult } from "./Module.ts";
import { join } from "@std/path";

export class Configuration extends Module {
  #params: Map<string, string> = new Map();
  #dirty: boolean = false;
  #cfgPath: string = "popfile.cfg";
  #userDir: string = "./";
  #rootDir: string = "./";

  constructor() {
    super();
    this.name_ = "config";
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override initialize(): LifecycleResult {
    // Global defaults — mirrors Configuration.pm::initialize()
    this.parameter("GLOBAL_timeout", "60");
    this.parameter("GLOBAL_msgdir", "messages/");
    this.parameter("GLOBAL_message_cutoff", "100000");
    this.parameter("GLOBAL_single_user", "1");
    this.parameter("GLOBAL_language", "English");
    this.parameter("GLOBAL_session_timeout", "1800");
    this.parameter("config_piddir", "./");
    this.parameter("config_pidcheck_interval", "5");
    this.parameter("config_user_dir", "./");
    this.parameter("config_root_dir", "./");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    this.#userDir = this.parameter("config_user_dir");
    this.#rootDir = this.parameter("config_root_dir");
    this.#cfgPath = join(this.#userDir, "popfile.cfg");
    this.#load();
    this.mqRegister_("TICKD", this);
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#save();
    super.stop();
  }

  /** MQ TICKD handler — save config if dirty. */
  override deliver(type: string): void {
    if (type === "TICKD" && this.#dirty) this.#save();
  }

  // -------------------------------------------------------------------------
  // Core API — used by Module.moduleConfig_()
  // -------------------------------------------------------------------------

  /**
   * Get or set a parameter. Returns the current (possibly default) value.
   * Passing undefined for value is a read; any other value is a write.
   */
  parameter(key: string, value?: string | number): string {
    if (value !== undefined) {
      const str = String(value);
      if (this.#params.get(key) !== str) {
        this.#params.set(key, str);
        this.#dirty = true;
      }
    }
    return this.#params.get(key) ?? "";
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  getUserPath(path: string, sandbox = false): string {
    return this.#resolvePath(this.#userDir, path, sandbox);
  }

  getRootPath(path: string, sandbox = false): string {
    return this.#resolvePath(this.#rootDir, path, sandbox);
  }

  #resolvePath(base: string, path: string, sandbox: boolean): string {
    if (sandbox && (path.startsWith("/") || path.includes(".."))) {
      throw new Error(`Sandboxed path rejected: ${path}`);
    }
    return join(base, path);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  #load(): void {
    try {
      const text = Deno.readTextFileSync(this.#cfgPath);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        this.#params.set(key, val);
      }
      this.#dirty = false;
    } catch {
      // File doesn't exist yet — that's fine, we'll create it on save.
    }
  }

  #save(): void {
    const lines: string[] = [
      "# POPFile configuration — auto-generated",
      `# Saved: ${new Date().toISOString()}`,
      "",
    ];
    for (const [key, val] of [...this.#params.entries()].sort()) {
      lines.push(`${key}=${val}`);
    }
    try {
      Deno.writeTextFileSync(this.#cfgPath, lines.join("\n") + "\n");
      this.#dirty = false;
    } catch (e) {
      console.error("Configuration: failed to save:", e);
    }
  }
}
