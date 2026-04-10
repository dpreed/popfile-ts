/**
 * tests/core_test.ts — Tests for Configuration and MessageQueue modules.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/core_test.ts
 */

import { assertEquals, assert, assertThrows } from "jsr:@std/assert";
import { join } from "@std/path";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Module, LifecycleResult, type ModuleRegistry } from "../core/Module.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Minimal concrete Module for use as a mock handler
// ---------------------------------------------------------------------------

class MockModule extends Module {
  deliveries: Array<[string, string[]]> = [];
  override initialize(): LifecycleResult { return LifecycleResult.Ok; }
  override deliver(type: string, ...args: string[]): void {
    this.deliveries.push([type, args]);
  }
}

// ---------------------------------------------------------------------------
// Minimal stack: config + mq + logger only
// ---------------------------------------------------------------------------

interface CoreStack {
  config: Configuration;
  mq: MessageQueue;
  loader: Loader;
  tmpDir: string;
  cleanup: () => void;
}

async function makeCoreStack(): Promise<CoreStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config", new Configuration(), 0);
  loader.register("mq",     new MessageQueue(),  0);
  loader.register("logger", new Logger(),         1);

  const modules = ["config", "mq", "logger"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("logger_log_level", "0");

  for (const alias of modules) loader.getModule(alias).start();

  return {
    config,
    mq: loader.getModule("mq") as MessageQueue,
    loader,
    tmpDir,
    cleanup: () => {
      for (const alias of [...modules].reverse()) {
        try { loader.getModule(alias).stop(); } catch { /* ok */ }
      }
      Deno.removeSync(tmpDir, { recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration — parameter API
// ---------------------------------------------------------------------------

Deno.test("Configuration: parameter() returns empty string for unset key", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    assertEquals(config.parameter("no_such_key_xyz"), "");
  } finally { cleanup(); }
});

Deno.test("Configuration: parameter() sets and returns value", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    config.parameter("test_foo", "hello");
    assertEquals(config.parameter("test_foo"), "hello");
  } finally { cleanup(); }
});

Deno.test("Configuration: parameter() with numeric value coerces to string", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    config.parameter("test_num", 42);
    assertEquals(config.parameter("test_num"), "42");
  } finally { cleanup(); }
});

Deno.test("Configuration: initialize() registers default config_user_dir", async () => {
  // Create a bare Configuration without calling start()
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();
  loader.register("config", new Configuration(), 0);
  loader.register("mq",     new MessageQueue(),  0);
  loader.register("logger", new Logger(),         1);
  const modules = ["config", "mq", "logger"];
  for (const alias of modules) loader.getModule(alias).initialize();
  const config = loader.getModule("config") as Configuration;
  try {
    // Default set by initialize() before start() loads the file
    assertEquals(config.parameter("config_user_dir"), "./");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Configuration — file persistence
// ---------------------------------------------------------------------------

Deno.test("Configuration: start() loads values from existing cfg file", async () => {
  const tmpDir = await Deno.makeTempDir();
  // Write a pre-existing config file
  await Deno.writeTextFile(
    join(tmpDir, "popfile.cfg"),
    "mymodule_mykey=loaded_value\n"
  );

  const loader = new Loader();
  loader.register("config", new Configuration(), 0);
  loader.register("mq",     new MessageQueue(),  0);
  loader.register("logger", new Logger(),         1);
  const modules = ["config", "mq", "logger"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("logger_log_level", "0");

  for (const alias of modules) loader.getModule(alias).start();

  try {
    assertEquals(config.parameter("mymodule_mykey"), "loaded_value");
  } finally {
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("Configuration: stop() saves parameters to cfg file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();
  loader.register("config", new Configuration(), 0);
  loader.register("mq",     new MessageQueue(),  0);
  loader.register("logger", new Logger(),         1);
  const modules = ["config", "mq", "logger"];
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  for (const alias of modules) loader.getModule(alias).start();

  config.parameter("save_test_key", "save_test_value");

  // Stop writes the file
  for (const alias of [...modules].reverse()) {
    try { loader.getModule(alias).stop(); } catch { /* ok */ }
  }

  const saved = Deno.readTextFileSync(join(tmpDir, "popfile.cfg"));
  assert(saved.includes("save_test_key=save_test_value"), "saved file should contain the key");

  Deno.removeSync(tmpDir, { recursive: true });
});

Deno.test("Configuration: parameters survive a save/load round-trip", async () => {
  const tmpDir = await Deno.makeTempDir();

  // First run: set values and save
  {
    const loader = new Loader();
    loader.register("config", new Configuration(), 0);
    loader.register("mq",     new MessageQueue(),  0);
    loader.register("logger", new Logger(),         1);
    const modules = ["config", "mq", "logger"];
    for (const alias of modules) loader.getModule(alias).initialize();
    const config = loader.getModule("config") as Configuration;
    config.parameter("config_user_dir",  tmpDir);
    config.parameter("config_root_dir",  tmpDir);
    config.parameter("logger_log_level", "0");
    for (const alias of modules) loader.getModule(alias).start();
    config.parameter("round_trip_key", "round_trip_value");
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
  }

  // Second run: load and verify
  {
    const loader = new Loader();
    loader.register("config", new Configuration(), 0);
    loader.register("mq",     new MessageQueue(),  0);
    loader.register("logger", new Logger(),         1);
    const modules = ["config", "mq", "logger"];
    for (const alias of modules) loader.getModule(alias).initialize();
    const config = loader.getModule("config") as Configuration;
    config.parameter("config_user_dir",  tmpDir);
    config.parameter("config_root_dir",  tmpDir);
    config.parameter("logger_log_level", "0");
    for (const alias of modules) loader.getModule(alias).start();
    try {
      assertEquals(config.parameter("round_trip_key"), "round_trip_value");
    } finally {
      for (const alias of [...modules].reverse()) {
        try { loader.getModule(alias).stop(); } catch { /* ok */ }
      }
      Deno.removeSync(tmpDir, { recursive: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Configuration — path helpers
// ---------------------------------------------------------------------------

Deno.test("Configuration: getUserPath() joins user dir with path", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    const p = config.getUserPath("subdir/file.txt");
    assert(p.endsWith("subdir/file.txt") || p.includes("subdir"), `unexpected path: ${p}`);
  } finally { cleanup(); }
});

Deno.test("Configuration: getRootPath() sandbox rejects absolute paths", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    assertThrows(() => config.getRootPath("/etc/passwd", true), Error, "Sandboxed path rejected");
  } finally { cleanup(); }
});

Deno.test("Configuration: getRootPath() sandbox rejects .. paths", async () => {
  const { config, cleanup } = await makeCoreStack();
  try {
    assertThrows(() => config.getRootPath("../escape", true), Error, "Sandboxed path rejected");
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// MessageQueue — delivery
// ---------------------------------------------------------------------------

/** Build a minimal MQ-only registry (no config/logger needed for direct calls). */
function makeMQStack(): { mq: MessageQueue; addMock: (name: string) => MockModule; cleanup: () => void } {
  const registry: ModuleRegistry = new Map();

  const config = new Configuration();
  config.setName("config");
  config.setRegistry(registry);
  registry.set("config", config);
  config.initialize();

  const mq = new MessageQueue();
  mq.setName("mq");
  mq.setRegistry(registry);
  registry.set("mq", mq);
  mq.initialize();

  const logger = new Logger();
  logger.setName("logger");
  logger.setRegistry(registry);
  registry.set("logger", logger);
  logger.initialize();

  // Start config first (needed by logger)
  const tmpDir = Deno.makeTempDirSync();
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  config.start();
  logger.start();
  mq.start();

  return {
    mq,
    addMock(name: string): MockModule {
      const m = new MockModule();
      m.setName(name);
      m.setRegistry(registry);
      registry.set(name, m);
      return m;
    },
    cleanup(): void {
      try { mq.stop(); } catch { /* ok */ }
      try { logger.stop(); } catch { /* ok */ }
      try { config.stop(); } catch { /* ok */ }
      Deno.removeSync(tmpDir, { recursive: true });
    },
  };
}

Deno.test("MessageQueue: post() to unregistered type drops silently", () => {
  const { mq, cleanup } = makeMQStack();
  try {
    // Should not throw
    mq.post("UNREGISTERED_TYPE", "arg1");
    mq.service(); // nothing to deliver
  } finally { cleanup(); }
});

Deno.test("MessageQueue: registered handler receives message on service()", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  try {
    const handler = addMock("handler1");
    mq.register("TICKD", handler);
    mq.post("TICKD");
    mq.service();
    assertEquals(handler.deliveries.length, 1);
    assertEquals(handler.deliveries[0][0], "TICKD");
  } finally { cleanup(); }
});

Deno.test("MessageQueue: deliver() receives correct args", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  try {
    const handler = addMock("handler2");
    mq.register("COMIT", handler);
    mq.post("COMIT", "session123", "extra");
    mq.service();
    assertEquals(handler.deliveries[0][1], ["session123", "extra"]);
  } finally { cleanup(); }
});

Deno.test("MessageQueue: multiple messages same type delivered FIFO", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  try {
    const handler = addMock("handler3");
    mq.register("COMIT", handler);
    mq.post("COMIT", "first");
    mq.post("COMIT", "second");
    mq.post("COMIT", "third");
    mq.service();
    assertEquals(handler.deliveries.length, 3);
    assertEquals(handler.deliveries[0][1], ["first"]);
    assertEquals(handler.deliveries[1][1], ["second"]);
    assertEquals(handler.deliveries[2][1], ["third"]);
  } finally { cleanup(); }
});

Deno.test("MessageQueue: CREAT delivered before TICKD (priority)", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  try {
    const handler = addMock("handler4");
    mq.register("CREAT", handler);
    mq.register("TICKD", handler);
    // Post TICKD first, then CREAT — CREAT should be delivered first
    mq.post("TICKD");
    mq.post("CREAT");
    mq.service();
    assertEquals(handler.deliveries[0][0], "CREAT");
    assertEquals(handler.deliveries[1][0], "TICKD");
  } finally { cleanup(); }
});

Deno.test("MessageQueue: multiple handlers all receive the message", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  try {
    const h1 = addMock("h1");
    const h2 = addMock("h2");
    const h3 = addMock("h3");
    mq.register("TICKD", h1);
    mq.register("TICKD", h2);
    mq.register("TICKD", h3);
    mq.post("TICKD");
    mq.service();
    assertEquals(h1.deliveries.length, 1);
    assertEquals(h2.deliveries.length, 1);
    assertEquals(h3.deliveries.length, 1);
  } finally { cleanup(); }
});

Deno.test("MessageQueue: stop() flushes pending messages", () => {
  const { mq, addMock, cleanup } = makeMQStack();
  const handler = addMock("handler5");
  mq.register("TICKD", handler);
  mq.post("TICKD");
  // Call stop() without calling service() first — cleanup() will call stop()
  cleanup();
  assertEquals(handler.deliveries.length, 1, "stop() should flush the queue");
});
