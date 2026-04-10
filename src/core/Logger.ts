// Copyright (c) 2025 David P. Reed. MIT License.
/**
 * Logger.ts — Logging and hourly TICKD events.
 *
 * Mirrors POPFile::Logger. Writes timestamped debug lines to a rotating
 * daily log file (or stdout when level >= threshold). Fires a TICKD
 * message on the MQ once per hour so other modules can do housekeeping.
 */

import { Module, LifecycleResult } from "./Module.ts";
import { join } from "@std/path";

const SECONDS_PER_HOUR = 3600;

export class Logger extends Module {
  #logFile: Deno.FsFile | null = null;
  #logPath: string = "";
  #level: number = 0;          // 0 = errors only, 1 = info, 2 = verbose
  #lastTickd: number = 0;
  #lastTen: string[] = [];     // circular buffer of last 10 log lines

  constructor() {
    super();
    this.name_ = "logger";
  }

  override initialize(): LifecycleResult {
    this.config_("log_dir", "logs");
    this.config_("log_level", "0");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    this.#level = parseInt(this.config_("log_level"), 10);
    const dir = this.config_("log_dir");
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch { /* exists */ }
    this.#openLogFile(dir);
    this.#lastTickd = Date.now();
    return LifecycleResult.Ok;
  }

  override service(): boolean {
    // Fire TICKD once per hour
    if ((Date.now() - this.#lastTickd) >= SECONDS_PER_HOUR * 1000) {
      this.#lastTickd = Date.now();
      this.mqPost_("TICKD");
      // Rotate log file daily
      const dir = this.config_("log_dir");
      this.#logFile?.close();
      this.#openLogFile(dir);
    }
    return true;
  }

  override stop(): void {
    this.#logFile?.close();
    this.#logFile = null;
    super.stop();
  }

  debug(level: number, message: string): void {
    if (level > this.#level) return;
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    if (this.#logFile) {
      const enc = new TextEncoder();
      this.#logFile.writeSync(enc.encode(line + "\n"));
    } else {
      console.log(line);
    }
    // Keep last 10 lines
    this.#lastTen.push(line);
    if (this.#lastTen.length > 10) this.#lastTen.shift();
  }

  lastTen(): string[] {
    return [...this.#lastTen];
  }

  #openLogFile(dir: string): void {
    const date = new Date().toISOString().slice(0, 10);
    this.#logPath = join(dir, `popfile-${date}.log`);
    try {
      this.#logFile = Deno.openSync(this.#logPath, { append: true, create: true, write: true });
    } catch (e) {
      console.error(`Logger: cannot open log file ${this.#logPath}:`, e);
      this.#logFile = null;
    }
  }
}
