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
  csrf: string;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function makeUIStack(existingTmpDir?: string): Promise<UIStack> {
  const tmpDir = existingTmpDir ?? await Deno.makeTempDir();
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

  // Fetch login page to get the login CSRF token
  const loginPageRes = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  const loginPageHtml = await loginPageRes.text();
  const loginCsrfMatch = /name="_login_csrf" value="([^"]+)"/.exec(loginPageHtml);
  const loginCsrf = loginCsrfMatch?.[1] ?? "";

  // Log in via the UI to get a browser session cookie (admin / blank password)
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "", _login_csrf: loginCsrf }),
  });
  await loginRes.body?.cancel();
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]; // e.g. "popfile_session=<token>"

  // Extract CSRF token from an authenticated page
  const statsRes = await fetch(`${baseUrl}/stats`, {
    redirect: "manual",
    headers: { "Cookie": cookie },
  });
  const statsHtml = await statsRes.text();
  const csrfMatch = /<meta name="csrf-token" content="([^"]+)"/.exec(statsHtml);
  const csrf = csrfMatch?.[1] ?? "";

  const cleanup = async () => {
    bayes.releaseSessionKey(session);
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
    // Give the server a moment to shut down
    await new Promise((r) => setTimeout(r, 10));
    // Only remove the directory if this stack created it
    if (!existingTmpDir) Deno.removeSync(tmpDir, { recursive: true });
  };

  return { ui, bayes, session, baseUrl, cookie, csrf, tmpDir, cleanup };
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
  csrf?: string,
): Promise<Response> {
  const isJson = typeof body === "string";
  let finalBody: URLSearchParams | string = body;
  if (!isJson && csrf && body instanceof URLSearchParams) {
    const params = new URLSearchParams(body);
    params.set("_csrf", csrf);
    finalBody = params;
  }
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
      "Cookie": cookie,
    },
    body: finalBody,
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

Deno.test("UIServer: POST /login without CSRF token returns login page with error", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "" }),
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Invalid request") || body.includes("try again"), "Expected CSRF error");
  } finally { await cleanup(); }
});

async function fetchLoginCsrf(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  const html = await res.text();
  return /name="_login_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

Deno.test("UIServer: POST /login with bad credentials returns 200 with error", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const loginCsrf = await fetchLoginCsrf(baseUrl);
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "wrongpassword", _login_csrf: loginCsrf }),
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Invalid"), "Expected error message");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /login with correct credentials redirects with cookie", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const loginCsrf = await fetchLoginCsrf(baseUrl);
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "", _login_csrf: loginCsrf }),
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

Deno.test("UIServer: GET /history returns 200 HTML with filter bar", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/history", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Filter"), "Expected filter bar");
    assert(body.includes("Export CSV"), "Expected export link");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history?bucket= filters by bucket", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    // Classify a message so history is non-empty
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const res = await get(baseUrl, "/history?bucket=spam", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("spam"), "Expected spam filter applied");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history?q= searches subject/from", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML); // subject: "Hello world"
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const resMatch = await get(baseUrl, "/history?q=Hello", cookie);
    assertEquals(resMatch.status, 200);
    const matchBody = await resMatch.text();
    assert(matchBody.includes("Hello world") || matchBody.includes("1 message"),
      "Expected matching message in results");

    const resNoMatch = await get(baseUrl, "/history?q=xyzzy_not_present", cookie);
    assertEquals(resNoMatch.status, 200);
    const noMatchBody = await resNoMatch.text();
    assert(noMatchBody.includes("No matching"), "Expected empty result for non-matching search");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history pagination shows page controls", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    // Create 30 history entries (more than one page of 25)
    for (let i = 0; i < 30; i++) {
      const tmp = await Deno.makeTempFile({ suffix: ".eml" });
      await Deno.writeTextFile(tmp,
        `From: a@b.com\r\nTo: b@c.com\r\nSubject: msg${i}\r\nContent-Type: text/plain\r\n\r\nhello`);
      try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }
    }
    const res = await get(baseUrl, "/history", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Next →"), "Expected next page link");
    assert(body.includes("Page 1 of"), "Expected page indicator");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history/export returns CSV", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const res = await get(baseUrl, "/history/export", cookie);
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.includes("text/csv"), `Expected CSV content-type, got: ${ct}`);
    const cd = res.headers.get("content-disposition") ?? "";
    assert(cd.includes(".csv"), "Expected CSV filename in Content-Disposition");
    const body = await res.text();
    assert(body.startsWith("id,date,from,subject"), "Expected CSV header row");
    // Should have at least one data row
    const lines = body.trim().split("\n");
    assert(lines.length >= 2, "Expected header + at least one data row");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history/export respects bucket filter", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const res = await get(baseUrl, "/history/export?bucket=spam", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    const lines = body.trim().split("\n");
    // Only header, no data rows (nothing classified as spam)
    assertEquals(lines.length, 1, "Expected only header row when no matching messages");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /history/retrain redirects back to same page", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const [entry] = bayes.getHistory(session);
    const form = new URLSearchParams({
      id: String(entry.id),
      bucket: "spam",
      back: "/history?page=2&bucket=inbox",
    });
    const res = await post(baseUrl, "/history/retrain", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303);
    const location = res.headers.get("location") ?? "";
    assert(location.includes("page=2") && location.includes("bucket=inbox"),
      `Expected redirect to preserve filters, got: ${location}`);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /classify returns 200 HTML with file upload form", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/classify", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes('type="file"'), "Expected file upload input");
    assert(body.includes('enctype="multipart/form-data"'), "Expected multipart form");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /classify with file upload returns classification result", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");
    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("upload", new File([SAMPLE_EML], "test.eml", { type: "message/rfc822" }));
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Result:"), `Expected classification result, got: ${body.substring(0, 200)}`);
    assert(body.includes("word scores"), "Expected word scores link");
    assert(body.includes("Train as"), "Expected train correction form");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /classify with trained message shows correct bucket", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    // Train spam words heavily
    const spamEml = [
      "From: spammer@bad.com",
      "To: victim@example.com",
      "Subject: Buy cheap viagra now",
      "Content-Type: text/plain",
      "",
      "Buy viagra cheap pills discount pharmacy offer limited",
      "Buy viagra cheap pills discount pharmacy offer limited",
      "Buy viagra cheap pills discount pharmacy offer limited",
    ].join("\r\n");
    const inboxEml = [
      "From: boss@work.com",
      "To: me@work.com",
      "Subject: Meeting tomorrow",
      "Content-Type: text/plain",
      "",
      "Can we schedule a meeting tomorrow to discuss the project status?",
    ].join("\r\n");
    // Train 5 copies of each so Bayes has enough signal
    for (let i = 0; i < 5; i++) {
      const tmp = await Deno.makeTempFile({ suffix: ".eml" });
      await Deno.writeTextFile(tmp, spamEml);
      bayes.trainMessage(session, "spam", new (await import("../classifier/MailParser.ts")).MailParser().parseFile(tmp));
      await Deno.remove(tmp);
    }
    for (let i = 0; i < 5; i++) {
      const tmp = await Deno.makeTempFile({ suffix: ".eml" });
      await Deno.writeTextFile(tmp, inboxEml);
      bayes.trainMessage(session, "inbox", new (await import("../classifier/MailParser.ts")).MailParser().parseFile(tmp));
      await Deno.remove(tmp);
    }

    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("upload", new File([spamEml], "spam.eml", { type: "message/rfc822" }));
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("spam"), `Expected spam in result, got: ${body.substring(0, 300)}`);
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

Deno.test("UIServer: GET /wordscores shows file upload form", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/wordscores", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes('type="file"'), "Expected file upload input");
    assert(body.includes('enctype="multipart/form-data"'), "Expected multipart form");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /wordscores upload redirects to ?id=", async () => {
  const { baseUrl, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("upload", new File([SAMPLE_EML], "test.eml", { type: "message/rfc822" }));
    const res = await fetch(`${baseUrl}/wordscores`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    assert(res.status === 302 || res.status === 303, `Expected redirect, got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert(location.includes("?id="), `Expected ?id= in redirect, got: ${location}`);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /wordscores?id= resolves cached file and shows analysis", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");

    // Upload via POST to get a cache ID
    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("upload", new File([SAMPLE_EML], "test.eml", { type: "message/rfc822" }));
    const postRes = await fetch(`${baseUrl}/wordscores`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    const location = postRes.headers.get("location") ?? "";
    await postRes.body?.cancel();
    assert(location.includes("?id="), "Expected redirect with cache id");

    // Follow the redirect to get the analysis
    const id = new URL(location, baseUrl).searchParams.get("id") ?? "";
    const res = await get(baseUrl, `/wordscores?id=${encodeURIComponent(id)}`, cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Classification:"), "Expected classification result");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /wordscores?id= with invalid id shows error message", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/wordscores?id=00000000-0000-0000-0000-000000000000", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("no longer available") || body.includes("expired"),
      "Expected expiry message for missing cache entry");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /classify word scores link uses ?id= not ?file=", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("upload", new File([SAMPLE_EML], "test.eml", { type: "message/rfc822" }));
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("/wordscores?id="), "Expected word scores link with ?id=");
    assert(!body.includes("/wordscores?file="), "Should not use ?file= for uploads");
    assert(!body.includes('name="file"'), "Train correction form must not expose server paths");
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
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ name: "testbucket" });
    const res = await post(baseUrl, "/buckets/create", form, cookie, csrf);
    // Expect redirect after creation
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const buckets = bayes.getBuckets(session);
    assert(buckets.includes("testbucket"), "Bucket should have been created");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /buckets/delete deletes a bucket and redirects", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "tobedeleted");
    const form = new URLSearchParams({ name: "tobedeleted" });
    const res = await post(baseUrl, "/buckets/delete", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const buckets = bayes.getBuckets(session);
    assert(!buckets.includes("tobedeleted"), "Bucket should have been deleted");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /buckets/color sets bucket color and redirects", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "colorbucket");
    const form = new URLSearchParams({ name: "colorbucket", color: "#ff0000" });
    const res = await post(baseUrl, "/buckets/color", form, cookie, csrf);
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
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    const form = new URLSearchParams({ bucket: "spam", type: "from", value: "spammer@evil.com" });
    const res = await post(baseUrl, "/magnets/add", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const magnets = bayes.getMagnets(session);
    assert(magnets.some((m) => m.val === "spammer@evil.com"), "Magnet should have been added");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /magnets/delete removes a magnet and redirects", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.addMagnet(session, "spam", "from", "delete@me.com");
    const before = bayes.getMagnets(session);
    const magnet = before.find((m) => m.val === "delete@me.com");
    assert(magnet !== undefined, "Magnet should exist before delete");
    const form = new URLSearchParams({ id: String(magnet!.id) });
    const res = await post(baseUrl, "/magnets/delete", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303 || res.status === 200, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const after = bayes.getMagnets(session);
    assert(!after.some((m) => m.val === "delete@me.com"), "Magnet should have been deleted");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Removed file-path API endpoints return 404
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /api/classify is removed (404)", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/api/classify?file=/etc/passwd", cookie);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /api/train is removed (404)", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await post(baseUrl, "/api/train", JSON.stringify({}), cookie);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /wordscores?file= is ignored (no result)", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/wordscores?file=/etc/passwd", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(!body.includes("Classification:"), "Should not classify server-side paths");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Prometheus /metrics endpoint
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /metrics returns Prometheus text without auth", async () => {
  const { baseUrl, bayes, session, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");
    // No history seeding needed — just verify the metric keys are present
    // No cookie — unauthenticated request
    const res = await fetch(`${baseUrl}/metrics`);
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.includes("text/plain"), `Expected text/plain, got: ${ct}`);
    const body = await res.text();
    assert(body.includes("popfile_classified_total"), "Expected classified counter");
    assert(body.includes("popfile_retrained_total"), "Expected retrained counter");
    assert(body.includes("popfile_magnet_hits_total"), "Expected magnet hits counter");
    assert(body.includes('popfile_words_trained_total{bucket="inbox"}'), "Expected inbox gauge");
    assert(body.includes('popfile_words_trained_total{bucket="spam"}'), "Expected spam gauge");
    assert(body.includes("popfile_uptime_seconds"), "Expected uptime gauge");
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
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ username: "alice", password: "secret" });
    const res = await post(baseUrl, "/users/create", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const users = bayes.listUsers(session);
    assert(users.some((u) => u.name === "alice"), "User alice should have been created");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /users/delete removes a user", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    await bayes.createUserAccount(session, "bob", "pass");
    const form = new URLSearchParams({ username: "bob" });
    const res = await post(baseUrl, "/users/delete", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303, `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const users = bayes.listUsers(session);
    assert(!users.some((u) => u.name === "bob"), "User bob should have been deleted");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Training UI — file upload and bulk import
// ---------------------------------------------------------------------------

const SAMPLE_EML = [
  "From: alice@example.com",
  "To: bob@example.com",
  "Subject: Hello world",
  "Content-Type: text/plain",
  "",
  "This is a test message for training.",
].join("\r\n");

Deno.test("UIServer: GET /train shows file upload form", async () => {
  const { baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    const res = await get(baseUrl, "/train", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes('type="file"'), "Expected file upload input");
    assert(body.includes('enctype="multipart/form-data"'), "Expected multipart form");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /train with file upload trains the message", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    const before = bayes.getBucketWordCount(session, "inbox");

    const formData = new FormData();
    formData.append("_csrf", csrf);
    formData.append("bucket", "inbox");
    formData.append("upload", new File([SAMPLE_EML], "test.eml", { type: "message/rfc822" }));

    const res = await fetch(`${baseUrl}/train`, {
      method: "POST",
      redirect: "manual",
      headers: { "Cookie": cookie },
      body: formData,
    });
    const body = await res.text();
    assertEquals(res.status, 200);
    assert(body.includes("Trained"), `Expected success message, got: ${body.substring(0, 200)}`);

    const after = bayes.getBucketWordCount(session, "inbox");
    assert(after > before, "Word count should have increased after training");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /train/import imports .eml files from training dir", async () => {
  const { baseUrl, bayes, session, cookie, csrf, tmpDir, cleanup } = await makeUIStack();
  try {
    // Create training/spam/ with two .eml files
    await Deno.mkdir(`${tmpDir}/training/spam`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/training/spam/1.eml`, SAMPLE_EML);
    await Deno.writeTextFile(`${tmpDir}/training/spam/2.eml`, SAMPLE_EML);

    const form = new URLSearchParams({ bucket: "spam" });
    const res = await post(baseUrl, "/train/import", form, cookie, csrf);
    const body = await res.text();
    assertEquals(res.status, 200);
    assert(body.includes("spam"), `Expected spam in result: ${body.substring(0, 300)}`);
    assert(body.includes("trained"), "Expected trained count in result");

    const wc = bayes.getBucketWordCount(session, "spam");
    assert(wc > 0, "Expected word count > 0 after import");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /train shows bulk import section when training/ dir exists", async () => {
  const { baseUrl, cookie, tmpDir, cleanup } = await makeUIStack();
  try {
    // Create training/inbox/ with one .eml
    await Deno.mkdir(`${tmpDir}/training/inbox`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/training/inbox/msg.eml`, SAMPLE_EML);

    const res = await get(baseUrl, "/train", cookie);
    const body = await res.text();
    assertEquals(res.status, 200);
    assert(body.includes("Bulk import"), "Expected bulk import section");
    assert(body.includes("inbox"), "Expected inbox bucket listed");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

Deno.test("UIServer: expired Bayes session redirects to /login?expired=1", async () => {
  const { baseUrl, bayes, cookie, cleanup } = await makeUIStack();
  try {
    // Find the Bayes session key for the browser session by exploiting the
    // fact that the cookie token maps to a bayes key — we force it invalid by
    // releasing every session except the admin one set up in makeUIStack.
    // The simplest way: fetch the stats page to confirm we're logged in, then
    // reach into bayes and release all sessions, then try again.
    const before = await get(baseUrl, "/stats", cookie);
    assertEquals(before.status, 200);
    await before.body?.cancel();

    // Release all Bayes sessions (simulates server-side timeout)
    bayes.releaseAllSessions();

    const res = await get(baseUrl, "/buckets", cookie);
    // Should redirect to /login?expired=1 and clear the cookie
    assert(res.status === 302 || res.status === 303, `Expected redirect, got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert(location.includes("expired=1"), `Expected expired=1 in redirect, got: ${location}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(setCookie.includes("Max-Age=0"), "Expected cookie to be cleared");
    await res.body?.cancel();
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /login?expired=1 shows session-expired message", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    const res = await fetch(`${baseUrl}/login?expired=1`, { redirect: "manual" });
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("expired") || body.includes("session"), "Expected expiry message");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

async function loginAttempt(baseUrl: string, password: string): Promise<Response> {
  const loginCsrf = await fetchLoginCsrf(baseUrl);
  return await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password, _login_csrf: loginCsrf }),
  });
}

Deno.test("UIServer: 10 failed logins trigger rate limit", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    // Send 10 bad-password attempts (threshold) — each needs a fresh CSRF token
    for (let i = 0; i < 10; i++) {
      const res = await loginAttempt(baseUrl, "wrong");
      await res.body?.cancel();
    }
    // 11th attempt should hit the rate limit
    const res = await loginAttempt(baseUrl, "");
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("Too many") || body.includes("rate") || body.includes("later"),
      `Expected rate-limit message, got: ${body.substring(0, 200)}`);
  } finally { await cleanup(); }
});

Deno.test("UIServer: successful login clears failed-attempt counter", async () => {
  const { baseUrl, cleanup } = await makeUIStack();
  try {
    // 9 failures (one below threshold)
    for (let i = 0; i < 9; i++) {
      const r = await loginAttempt(baseUrl, "bad");
      await r.body?.cancel();
    }
    // Successful login — clears the counter
    const ok = await loginAttempt(baseUrl, "");
    assert(ok.status === 302 || ok.status === 303, `Expected redirect on success, got ${ok.status}`);
    await ok.body?.cancel();

    // Another 9 failures should still be allowed (counter was reset)
    for (let i = 0; i < 9; i++) {
      const r = await loginAttempt(baseUrl, "bad");
      assertEquals(r.status, 200);
      const b = await r.text();
      assert(!b.includes("Too many"), "Should not be rate-limited after counter reset");
    }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// History export
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /history/export returns CSV with headers", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    // Classify a message to populate history
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    const res = await get(baseUrl, "/history/export", cookie);
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert(ct.includes("text/csv"), `Expected text/csv, got: ${ct}`);
    const cd = res.headers.get("content-disposition") ?? "";
    assert(cd.includes("attachment"), "Expected attachment disposition");
    assert(cd.includes(".csv"), "Expected .csv filename");
    const body = await res.text();
    // First line must be the header row
    const firstLine = body.split("\r\n")[0];
    assert(firstLine.includes("id"), "Expected id column");
    assert(firstLine.includes("subject"), "Expected subject column");
    assert(firstLine.includes("bucket"), "Expected bucket column");
  } finally { await cleanup(); }
});

Deno.test("UIServer: GET /history/export?bucket= filters by bucket", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try { bayes.classify(session, tmp); } finally { await Deno.remove(tmp); }

    // Filter for a bucket that has no messages
    const res = await get(baseUrl, "/history/export?bucket=spam", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    // Only the header row — no data rows for empty bucket
    assertEquals(lines.length, 1, "Expected only header row for empty bucket filter");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// TICKD sweep (deliver)
// ---------------------------------------------------------------------------

Deno.test("UIServer: TICKD sweep removes stale browser sessions", async () => {
  const { ui, bayes, session, baseUrl, cookie, cleanup } = await makeUIStack();
  try {
    // Expire all Bayes sessions (including the one backing the browser cookie)
    // without making another browser request. The browser cookie still exists
    // but its Bayes session is now gone.
    bayes.releaseAllSessions();

    // Trigger the hourly sweep
    ui.deliver("TICKD");

    // The browser session entry is gone — request should redirect to /login
    const res = await fetch(`${baseUrl}/stats`, {
      redirect: "manual",
      headers: { "Cookie": cookie },
    });
    await res.body?.cancel();
    assert(
      res.status === 302 || res.status === 303,
      `Expected redirect after session sweep, got ${res.status}`,
    );
    const location = res.headers.get("location") ?? "";
    assert(location.includes("/login"), `Expected redirect to /login, got: ${location}`);
  } finally { await cleanup(); }
});

Deno.test("UIServer: TICKD sweep resets partial rate-limiter counts", async () => {
  const { ui, baseUrl, cleanup } = await makeUIStack();
  try {
    // Accumulate 5 failed logins (below the lockout threshold of 10)
    for (let i = 0; i < 5; i++) {
      const r = await loginAttempt(baseUrl, "wrong");
      await r.body?.cancel();
    }
    // Sweep clears the partial count
    ui.deliver("TICKD");
    // 5 more failures should NOT trigger lockout (counter was reset to 0)
    for (let i = 0; i < 5; i++) {
      const r = await loginAttempt(baseUrl, "wrong");
      const body = await r.text();
      assert(!body.includes("Too many"), `Unexpected rate-limit at attempt ${i + 1} after sweep`);
    }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// History retrain
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /history/retrain reassigns a history entry", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");

    // Keep the file alive through retrain so retrainHistory can re-parse it
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    try {
      bayes.classify(session, tmp);

      const history = bayes.getHistory(session);
      assertEquals(history.length, 1, "Expected one history entry");
      const id = history[0].id;

      const form = new URLSearchParams({ id: String(id), bucket: "spam", back: "/history" });
      const res = await post(baseUrl, "/history/retrain", form, cookie, csrf);
      assert(res.status === 302 || res.status === 303, `Expected redirect, got ${res.status}`);
      await res.body?.cancel();

      const updated = bayes.getHistory(session);
      assertEquals(updated[0].bucket, "spam", "History entry bucket should be updated to spam");
    } finally { await Deno.remove(tmp); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /settings saves a config value", async () => {
  const { baseUrl, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ classifier_unclassified_weight: "100" });
    const res = await post(baseUrl, "/settings", form, cookie, csrf);
    assertEquals(res.status, 200, "Expected settings page (200) after save");
    const body = await res.text();
    assert(body.includes("saved") || body.includes("Settings"), "Expected confirmation on settings page");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /settings is forbidden for non-admin", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    // Create a non-admin user and log in as them
    await bayes.createUserAccount(session, "bob", "pass");
    const bobCsrfRes = await fetch(`${baseUrl}/login`);
    const bobLoginHtml = await bobCsrfRes.text();
    const bobToken = /name="_login_csrf" value="([^"]+)"/.exec(bobLoginHtml)?.[1] ?? "";
    const bobLoginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "bob", password: "pass", _login_csrf: bobToken }),
    });
    await bobLoginRes.body?.cancel();
    const bobCookie = (bobLoginRes.headers.get("set-cookie") ?? "").split(";")[0];

    const form = new URLSearchParams({ classifier_unclassified_weight: "100" });
    const res = await post(baseUrl, "/settings", form, bobCookie);
    assertEquals(res.status, 403, "Non-admin should be forbidden from changing settings");
    await res.body?.cancel();
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /users/password changes password and allows re-login", async () => {
  const { baseUrl, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ password: "newpass", confirm: "newpass" });
    const res = await post(baseUrl, "/users/password", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303, `Expected redirect, got ${res.status}`);
    await res.body?.cancel();

    // Should now be able to log in with the new password
    const loginCsrfRes = await fetch(`${baseUrl}/login`);
    const loginHtml = await loginCsrfRes.text();
    const loginToken = /name="_login_csrf" value="([^"]+)"/.exec(loginHtml)?.[1] ?? "";
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "newpass", _login_csrf: loginToken }),
    });
    await loginRes.body?.cancel();
    assert(loginRes.headers.get("set-cookie")?.includes("popfile_session"),
      "Should receive a new session cookie after login with new password");
  } finally { await cleanup(); }
});

Deno.test("UIServer: POST /users/password ignores mismatched confirm", async () => {
  const { baseUrl, cookie, csrf, cleanup } = await makeUIStack();
  try {
    const form = new URLSearchParams({ password: "newpass", confirm: "different" });
    const res = await post(baseUrl, "/users/password", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303, `Expected redirect, got ${res.status}`);
    await res.body?.cancel();

    // Old (blank) password must still work
    const loginCsrfRes = await fetch(`${baseUrl}/login`);
    const loginHtml = await loginCsrfRes.text();
    const loginToken = /name="_login_csrf" value="([^"]+)"/.exec(loginHtml)?.[1] ?? "";
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "", _login_csrf: loginToken }),
    });
    await loginRes.body?.cancel();
    assert(loginRes.headers.get("set-cookie")?.includes("popfile_session"),
      "Blank password should still work when confirm was mismatched");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// History export — search filter
// ---------------------------------------------------------------------------

Deno.test("UIServer: GET /history/export?q= filters by subject keyword", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "inbox");

    // Classify two messages with distinct subjects
    const tmp1 = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp1, SAMPLE_EML); // subject: "Hello world"
    try { bayes.classify(session, tmp1); } finally { await Deno.remove(tmp1); }

    const other = [
      "From: other@example.com",
      "Subject: Totally different topic",
      "Content-Type: text/plain",
      "",
      "Something else.",
    ].join("\r\n");
    const tmp2 = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp2, other);
    try { bayes.classify(session, tmp2); } finally { await Deno.remove(tmp2); }

    // Search for "Hello" — should return only the first message
    const res = await get(baseUrl, "/history/export?q=Hello", cookie);
    assertEquals(res.status, 200);
    const body = await res.text();
    const dataLines = body.split("\r\n").filter((l) => l.length > 0).slice(1); // skip header
    assertEquals(dataLines.length, 1, "Expected exactly one matching row");
    assert(dataLines[0].includes("Hello world"), "Expected matching subject in CSV row");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Magnet cc field
// ---------------------------------------------------------------------------

Deno.test("UIServer: POST /magnets/add supports cc magnet type", async () => {
  const { baseUrl, bayes, session, cookie, csrf, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "lists");
    const form = new URLSearchParams({ bucket: "lists", type: "cc", value: "newsletter@example.com" });
    const res = await post(baseUrl, "/magnets/add", form, cookie, csrf);
    assert(res.status === 302 || res.status === 303 || res.status === 200,
      `Unexpected status ${res.status}`);
    await res.body?.cancel();
    const magnets = bayes.getMagnets(session);
    const m = magnets.find((m) => m.val === "newsletter@example.com");
    assert(m !== undefined, "cc magnet should have been added");
    assertEquals(m!.type, "cc", "Magnet type should be cc");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// CSRF enforcement — all mutation routes must reject missing/wrong token
// ---------------------------------------------------------------------------

Deno.test("UIServer: mutation routes return 403 without valid CSRF token", async () => {
  const { baseUrl, bayes, session, cookie, cleanup } = await makeUIStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.addMagnet(session, "spam", "from", "x@x.com");
    const magnetId = bayes.getMagnets(session)[0].id;

    // Classify a message to get a history id
    const tmp = await Deno.makeTempFile({ suffix: ".eml" });
    await Deno.writeTextFile(tmp, SAMPLE_EML);
    let historyId = 0;
    try {
      bayes.classify(session, tmp);
      historyId = bayes.getHistory(session)[0].id;
    } finally { await Deno.remove(tmp); }

    const routes: Array<[string, URLSearchParams]> = [
      ["/buckets/create",   new URLSearchParams({ name: "newbucket" })],
      ["/buckets/delete",   new URLSearchParams({ name: "spam" })],
      ["/buckets/color",    new URLSearchParams({ name: "spam", color: "#ff0000" })],
      ["/magnets/add",      new URLSearchParams({ bucket: "spam", type: "from", value: "y@y.com" })],
      ["/magnets/delete",   new URLSearchParams({ id: String(magnetId) })],
      ["/history/retrain",  new URLSearchParams({ id: String(historyId), bucket: "spam" })],
      ["/settings",         new URLSearchParams({ classifier_unclassified_weight: "1" })],
      ["/users/create",     new URLSearchParams({ username: "ghost", password: "x" })],
      ["/users/delete",     new URLSearchParams({ username: "ghost" })],
      ["/users/password",   new URLSearchParams({ password: "x", confirm: "x" })],
    ];

    for (const [path, form] of routes) {
      // POST with no _csrf field at all
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Cookie": cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.body?.cancel();
      assertEquals(res.status, 403, `Expected 403 for ${path} without CSRF token`);

      // POST with a wrong _csrf value
      const badForm = new URLSearchParams(form);
      badForm.set("_csrf", "not-the-right-token");
      const res2 = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Cookie": cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: badForm.toString(),
      });
      await res2.body?.cancel();
      assertEquals(res2.status, 403, `Expected 403 for ${path} with wrong CSRF token`);
    }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// popfile.cfg round-trip via UI: POST /settings → stop → restart → value restored
// ---------------------------------------------------------------------------

Deno.test("UIServer: settings saved via POST /settings survive a restart", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // First run: change a setting through the UI
    {
      const { baseUrl, cookie, csrf, cleanup } = await makeUIStack(tmpDir);
      try {
        const form = new URLSearchParams({ classifier_unclassified_weight: "42" });
        const res = await post(baseUrl, "/settings", form, cookie, csrf);
        assertEquals(res.status, 200, "Expected settings page after save");
        await res.body?.cancel();
      } finally {
        await cleanup(); // triggers Configuration.stop() → writes popfile.cfg
      }
    }

    // Second run: new stack on same directory — value must be restored from disk
    {
      const { baseUrl, cookie, cleanup } = await makeUIStack(tmpDir);
      try {
        const res = await fetch(`${baseUrl}/settings`, {
          redirect: "manual",
          headers: { "Cookie": cookie },
        });
        assertEquals(res.status, 200);
        const body = await res.text();
        assert(body.includes("42"), "Saved setting should appear in the settings page after restart");
      } finally {
        await cleanup();
      }
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
