// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * Loader.ts — Boot sequencer for POPFile modules.
 *
 * Mirrors POPFile::Loader. Registers all modules in a shared registry,
 * then runs the lifecycle stages in the defined order:
 *
 *   Level 0: Configuration, MessageQueue
 *   Level 1: Logger
 *   Level 2: Database
 *   Level 3: Classifier (Bayes)
 *   Level 4: Proxies and Services
 *   Level 5: UI
 *
 * After startup, drives the main service() loop and handles graceful
 * shutdown via SIGINT / SIGTERM.
 */

import { Module, ModuleRegistry, LifecycleResult } from "./Module.ts";

export class Loader {
  #registry: ModuleRegistry = new Map();
  #runLevels: Module[][] = [[], [], [], [], [], []];
  #alive = true;

  // -------------------------------------------------------------------------
  // Registration — call before boot()
  // -------------------------------------------------------------------------

  /**
   * Register a module. The alias becomes the key used by getModule_().
   * runLevel controls initialization order (0 = earliest).
   */
  register(alias: string, module: Module, runLevel: number): void {
    if (runLevel < 0 || runLevel >= this.#runLevels.length) {
      throw new Error(`Invalid run level ${runLevel} for module '${alias}'`);
    }
    module.setName(alias);
    module.setRegistry(this.#registry);
    this.#registry.set(alias, module);
    this.#runLevels[runLevel].push(module);
  }

  getModule(alias: string): Module {
    const m = this.#registry.get(alias);
    if (!m) throw new Error(`Unknown module: ${alias}`);
    return m;
  }

  // -------------------------------------------------------------------------
  // Boot sequence
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    console.log("POPFile starting…");

    // 1. Initialize all modules in run-level order
    for (let level = 0; level < this.#runLevels.length; level++) {
      for (const mod of this.#runLevels[level]) {
        const result = mod.initialize();
        if (result === LifecycleResult.Fatal) {
          throw new Error(`Module '${mod.getName()}' failed initialize() at level ${level}`);
        }
      }
    }

    // 2. Start all modules in run-level order
    for (let level = 0; level < this.#runLevels.length; level++) {
      for (const mod of this.#runLevels[level]) {
        const result = mod.start();
        if (result === LifecycleResult.Fatal) {
          throw new Error(`Module '${mod.getName()}' failed start() at level ${level}`);
        }
        if (result === LifecycleResult.Skip) {
          console.log(`Module '${mod.getName()}' skipped (disabled)`);
        }
      }
    }

    console.log("POPFile started — entering service loop");

    // 3. Handle signals for graceful shutdown
    const shutdown = () => { this.#alive = false; };
    try {
      Deno.addSignalListener("SIGINT", shutdown);
      Deno.addSignalListener("SIGTERM", shutdown);
    } catch { /* Windows may not support all signals */ }

    // 4. Main service loop — yield to async I/O between iterations
    while (this.#alive) {
      for (const mod of this.#allModules()) {
        if (!mod.service()) {
          console.log(`Module '${mod.getName()}' requested shutdown`);
          this.#alive = false;
          break;
        }
      }
      // Yield to the event loop (allows async I/O, timers, etc.)
      await new Promise((r) => setTimeout(r, 10));
    }

    // 5. Stop all modules in reverse run-level order
    console.log("POPFile shutting down…");
    for (let level = this.#runLevels.length - 1; level >= 0; level--) {
      for (const mod of [...this.#runLevels[level]].reverse()) {
        try { mod.stop(); } catch (e) {
          console.error(`Error stopping '${mod.getName()}':`, e);
        }
      }
    }
    console.log("POPFile stopped.");
  }

  #allModules(): Module[] {
    return this.#runLevels.flat();
  }
}
