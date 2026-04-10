/**
 * tests/ui_test.ts — HTTP route tests for UIServer.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/ui_test.ts
 *
 * Uses port 0 so OS picks an available port, avoiding conflicts with the
 * real server or parallel test runs.
 *
 * All routes require authentication (login cookie). The test harness logs
 * in as admin (blank password) before each test.
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { UIServer } from "../ui/UIServer.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface UIStack {
  ui: UIServer;
  bayes: Bayes;
  session: string;
  baseUrl: string;
  cookie: string;
  cleanup: () => Promise<void>;
}

async function makeUIStack(): Promise<UIStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config",     new Configuration(), 0);
  loader.register("mq",        new MessageQueue(),  0);
  loader.register("logger",    new Logger(),         1);
  loader.register("database",  new Database(),       2);
  loader.register("classifier", new Bayes(),         3);
  loader.register("ui",        new UIServer(),       5);

  const modules = ["config", "mq", "logger", "database", "classifier", "ui"];

  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  config.parameter("config_user_dir",  tmpDir);
  config.parameter("config_root_dir",  tmpDir);
  config.parameter("GLOBAL_user_dir",  tmpDir);
  config.parameter("logger_log_level", "0");
  // Use port 0 so the OS assigns a free port
  config.parameter("ui_port", "0");

  for (const alias of modules) loader.getModule(alias).start();

  const ui = loader.getModule("ui") as UIServer;
  const bayes = loader.getModule("classifier") as Bayes;
  // Grab an admin Bayes session for direct API calls in tests
  const session = bayes.getAdministratorSessionKey();
  const port = ui.getListenPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Log in via the UI to get a browser session cookie (admin / blank password)
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "" }),
  });
  await loginRes.body?.cancel();
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]; // e.g. "popfile_session=<token>"

  const cleanup = async () => {
    bayes.releaseSessionKey(session);
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
    // Give the server a moment to shut down
    await new Promise((r) => setTimeout(r, 10));
    Deno.removeSync(tmpDir, { recursive: true });
  };

  return { ui, bayes, session, baseUrl, cookie, cleanup };
}

// ---------------------------------------------------------------------------
// Helpers (include cookie in every request)
// ---------------------------------------------------------------------------

async function get(baseUrl: string, path: string, cookie: string): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: { "Cookie": cookie },
  });
}

async function post(
  baseUrl: string,
  path: string,
  body: URLSearchParams | string,
  cookie: string,
): Promise<Response> {
  const isJson = typeof body === "string";
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
      "Cookie": cookie,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Login / auth tests
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /login returns 200 HTML", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Sign in"), "Expected login page");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /login with bad credentials returns 200 with error", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "wrongpassword" }),
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Invalid"), "Expected error message");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /login with correct credentials redirects with cookie", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "" }),
    });
    assertEquals(res.status, 303);
    assert(res.headers.get("set-cookie")?.includes("popfile_session="), "Expected session cookie");
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: unauthenticated request redirects to /login", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/stats`, { redirect: "manual" });
    assertEquals(res.status, 303);
    assert(res.headers.get("location")?.includes("/login"), "Expected redirect to /login");
    await res.body?.cancel();
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Basic route smoke tests
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET / redirects to /stats", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/", cookie);
    assertEquals(res.status, 302);
    assert(res.headers.get("location")?.includes("/stats"), `Expected redirect to /stats, got ${res.headers.get("location")}`);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /stats returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/stats", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("<!DOCTYPE html") || body.includes("<html"), "Expected HTML document");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /buckets returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/buckets", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("<html") || body.includes("bucket"), "Expected HTML content");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /magnets returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/magnets", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/history", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /classify returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/classify", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /train returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/train", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /settings returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/settings", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("settings") || body.includes("Settings") || body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /wordscores returns 200 HTML", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/wordscores", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.length > 0);
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /nonexistent returns 404", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/nonexistent_page_xyz", cookie);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /api/buckets returns JSON array", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    const res = await get(baseUrl, "/api/buckets", cookie);
    assertEquals(res.status, 200);
    const data = await res.json() as Array<{ name: string; wordCount: number }>;
    assert(Array.isArray(data), "Expected JSON array");
    const names = data.map((b) => b.name);
    assert(names.includes("spam"), "Expected spam bucket");
    assert(names.includes("inbox"), "Expected inbox bucket");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /api/stats returns JSON with bucket stats", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    const res = await get(baseUrl, "/api/stats", cookie);
    assertEquals(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert("buckets" in data || Array.isArray(data), "Expected stats JSON");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Bucket management
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /buckets/create creates a bucket and redirects", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ name: "testbucket" });
    const res = await post(baseUrl, "/buckets/create", form, cookie);
    // Expect redirect after creation
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const buckets = bayes.getBuckets(session);
    assert(buckets.includes("testbucket"), "Bucket should have been created");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /buckets/delete deletes a bucket and redirects", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "tobedeleted");
    const form = new URLSearchParams({ name: "tobedeleted" });
    const res = await post(baseUrl, "/buckets/delete", form, cookie);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const buckets = bayes.getBuckets(session);
    assert(!buckets.includes("tobedeleted"), "Bucket should have been deleted");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /buckets/color sets bucket color and redirects", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "colorbucket");
    const form = new URLSearchParams({ name: "colorbucket", color: "#ff0000" });
    const res = await post(baseUrl, "/buckets/color", form, cookie);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const colors = bayes.getBucketColors(session);
    assertEquals(colors.get("colorbucket"), "#ff0000");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Magnet management
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /magnets/add adds a magnet and redirects", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    const form = new URLSearchParams({ bucket: "spam", type: "from", value: "spammer@evil.com" });
    const res = await post(baseUrl, "/magnets/add", form, cookie);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const magnets = bayes.getMagnets(session);
    assert(magnets.some((m) => m.val === "spammer@evil.com"), "Magnet should have been added");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /magnets/delete removes a magnet and redirects", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.addMagnet(session, "spam", "from", "delete@me.com");
    const before = bayes.getMagnets(session);
    const magnet = before.find((m) => m.val === "delete@me.com");
    assert(magnet !== undefined, "Magnet should exist before delete");
    const form = new URLSearchParams({ id: String(magnet!.id) });
    const res = await post(baseUrl, "/magnets/delete", form, cookie);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const after = bayes.getMagnets(session);
    assert(!after.some((m) => m.val === "delete@me.com"), "Magnet should have been deleted");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// API train
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /api/train returns 400 for missing fields", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await post(baseUrl, "/api/train", JSON.stringify({}), cookie);
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Users management (admin)
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /users returns 200 HTML for admin", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/users", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("admin"), "Expected users page with admin user");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /users/create creates a new user", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ username: "alice", password: "secret" });
    const res = await post(baseUrl, "/users/create", form, cookie);
    assert(res.status === 302 || res.status === 303, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const users = bayes.listUsers(session);
    assert(users.some((u) => u.name === "alice"), "User alice should have been created");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /users/delete removes a user", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createUserAccount(session, "bob", "pass");
    const form = new URLSearchParams({ username: "bob" });
    const res = await post(baseUrl, "/users/delete", form, cookie);
    assert(res.status === 302 || res.status === 303, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const users = bayes.listUsers(session);
    assert(!users.some((u) => u.name === "bob"), "User bob should have been deleted");
  } finally { await cleanup(); }
});
