/**
 * MessageQueue.ts — Async intra-process event bus.
 *
 * Mirrors POPFile::MQ. Modules register interest in message types and
 * post messages without knowing which other modules are listening.
 * Delivery is FIFO within each type and happens during service().
 *
 * Message types (priority order):
 *   CREAT  — child process created a session key
 *   LOGIN  — proxy logged into remote server
 *   UIREG  — module registering a UI component
 *   COMIT  — message committed to history
 *   TICKD  — hourly tick from Logger
 *   RELSE  — session key being released
 */

import { Module, LifecycleResult } from "./Module.ts";

type MessageHandler = Module;

interface QueueEntry {
  message: string[];
}

const MESSAGE_PRIORITY: Record<string, number> = {
  CREAT: 1,
  LOGIN: 2,
  UIREG: 3,
  COMIT: 4,
  TICKD: 5,
  RELSE: 6,
};

export class MessageQueue extends Module {
  // Queued messages, indexed by type
  #queue: Map<string, QueueEntry[]> = new Map();

  // Registered handlers per type
  #waiters: Map<string, MessageHandler[]> = new Map();

  constructor() {
    super();
    this.name_ = "mq";
  }

  override initialize(): LifecycleResult {
    return LifecycleResult.Ok;
  }

  /**
   * Drain all queues, delivering messages in priority order.
   * Called from the main Loader event loop.
   */
  override service(): boolean {
    const types = [...this.#queue.keys()].sort((a, b) => {
      const pa = MESSAGE_PRIORITY[a] ?? 999;
      const pb = MESSAGE_PRIORITY[b] ?? 999;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });

    for (const type of types) {
      const entries = this.#queue.get(type) ?? [];
      this.#queue.set(type, []);
      for (const entry of entries) {
        const handlers = this.#waiters.get(type) ?? [];
        for (const handler of handlers) {
          this.log_(2, `Delivering ${type}(${entry.message.join(",")}) to ${handler.getName()}`);
          handler.deliver(type, ...entry.message);
        }
      }
    }
    return true;
  }

  override stop(): void {
    this.service(); // flush remaining messages
    super.stop();
  }

  // -------------------------------------------------------------------------
  // Public API used by all modules via mqPost_() / mqRegister_()
  // -------------------------------------------------------------------------

  register(type: string, handler: MessageHandler): void {
    if (!this.#waiters.has(type)) this.#waiters.set(type, []);
    this.#waiters.get(type)!.push(handler);
  }

  post(type: string, ...message: string[]): void {
    this.log_(2, `post ${type}(${message.join(",")})`);
    if (!this.#waiters.has(type)) {
      this.log_(2, `dropping post ${type} — no listeners`);
      return;
    }
    if (!this.#queue.has(type)) this.#queue.set(type, []);
    this.#queue.get(type)!.push({ message });
  }
}
