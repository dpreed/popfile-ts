// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * Module.ts — Base class for all POPFile modules.
 *
 * Mirrors POPFile::Module from the Perl source. Every subsystem
 * (classifier, proxies, UI, …) extends this class and gains access to
 * the shared configuration, logger, and message-queue infrastructure
 * through typed accessor methods.
 *
 * Naming convention kept from the original:
 *   publicMethod()   — callable by anyone
 *   protectedMethod_ — callable by subclasses only (convention, not enforced)
 *   #privateField    — truly private (JS private fields)
 */

import type { MessageQueue } from "./MessageQueue.ts";
import type { Configuration } from "./Configuration.ts";
import type { Logger } from "./Logger.ts";
import type { Database } from "./Database.ts";

// ---------------------------------------------------------------------------
// Module registry — populated by the Loader, read by get_module_()
// ---------------------------------------------------------------------------
export type ModuleRegistry = Map<string, Module>;

// ---------------------------------------------------------------------------
// Lifecycle return codes (mirrors Perl: 1 = ok, 0 = fatal, 2 = skip)
// ---------------------------------------------------------------------------
export const enum LifecycleResult {
  Ok = 1,
  Fatal = 0,
  Skip = 2,
}

// ---------------------------------------------------------------------------
// Module base class
// ---------------------------------------------------------------------------
export abstract class Module {
  /** Logical name used as the key in the module registry. */
  protected name_: string = "";

  /** Set to false to request graceful shutdown. */
  protected alive_: boolean = true;

  /** Reference to the central module registry (set by Loader). */
  #registry: ModuleRegistry | null = null;

  // Cached handles to sibling modules — populated lazily by getModule_().
  #moduleCache: Map<string, Module> = new Map();

  // -------------------------------------------------------------------------
  // Lifecycle — override in subclasses as needed
  // -------------------------------------------------------------------------

  /**
   * Called after construction. Set default config values here.
   * Config is NOT loaded from disk yet — do not read config values.
   */
  initialize(): LifecycleResult {
    return LifecycleResult.Ok;
  }

  /**
   * Called once all config has been loaded from disk.
   * Return LifecycleResult.Skip if this module should be disabled.
   */
  start(): LifecycleResult {
    return LifecycleResult.Ok;
  }

  /** Called when POPFile is shutting down. */
  stop(): void {
    // subclasses close resources here
  }

  /**
   * Called periodically from the main event loop.
   * Return false to request a graceful shutdown.
   */
  service(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Message queue helpers (protected — for subclass use)
  // -------------------------------------------------------------------------

  protected mqPost_(type: string, ...message: string[]): void {
    this.mq_().post(type, ...message);
  }

  protected mqRegister_(type: string, handler: Module): void {
    this.mq_().register(type, handler);
  }

  /** Called by MQ to deliver a message to this module. Override to handle. */
  deliver(_type: string, ..._message: string[]): void {}

  // -------------------------------------------------------------------------
  // Configuration helpers (protected)
  // -------------------------------------------------------------------------

  /** Get or set a config value scoped to this module. */
  protected config_(name: string, value?: string | number): string {
    return this.moduleConfig_(this.name_, name, value);
  }

  /** Get or set a global (cross-module) config value. */
  protected globalConfig_(name: string, value?: string | number): string {
    return this.moduleConfig_("GLOBAL", name, value);
  }

  /** Get or set a config value scoped to an arbitrary module name. */
  protected moduleConfig_(
    module: string,
    name: string,
    value?: string | number,
  ): string {
    return this.configuration_().parameter(`${module}_${name}`, value);
  }

  // -------------------------------------------------------------------------
  // Logging helper (protected)
  // -------------------------------------------------------------------------

  protected log_(level: number, message: string): void {
    this.logger_().debug(level, `${this.name_}: ${message}`);
  }

  // -------------------------------------------------------------------------
  // Module accessors — lazy, cached
  // -------------------------------------------------------------------------

  protected mq_(): MessageQueue {
    return this.getModule_<MessageQueue>("mq");
  }

  protected configuration_(): Configuration {
    return this.getModule_<Configuration>("config");
  }

  protected logger_(): Logger {
    return this.getModule_<Logger>("logger");
  }

  protected database_(): Database {
    return this.getModule_<Database>("database");
  }

  /** Returns the raw SQLite handle from the Database module. */
  protected db_(): import("@db/sqlite").Database {
    return this.database_().db();
  }

  protected getModule_<T extends Module>(alias: string): T {
    if (!this.#moduleCache.has(alias)) {
      if (!this.#registry) throw new Error(`Module registry not set on ${this.name_}`);
      const mod = this.#registry.get(alias);
      if (!mod) throw new Error(`Module '${alias}' not found in registry`);
      this.#moduleCache.set(alias, mod);
    }
    return this.#moduleCache.get(alias) as T;
  }

  // -------------------------------------------------------------------------
  // Public accessors (called by Loader)
  // -------------------------------------------------------------------------

  getName(): string { return this.name_; }
  setName(n: string): void { this.name_ = n; }
  setRegistry(r: ModuleRegistry): void { this.#registry = r; }
  isAlive(): boolean { return this.alive_; }
}
