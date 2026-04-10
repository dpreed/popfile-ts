// Copyright (c) 2026 David P. Reed. MIT License.
/**
 * UIServer.ts — Web UI HTTP server.
 *
 * Mirrors UI::HTTP + UI::HTML. Serves a simple REST/HTML interface for
 * managing buckets, magnets, viewing history, and reclassifying messages.
 *
 * Routes:
 *   GET  /                     → redirect to /buckets
 *   GET  /buckets              → list buckets + word counts
 *   POST /buckets/create       → create a bucket
 *   POST /buckets/delete       → delete a bucket
 *   POST /buckets/color        → set a bucket's colour
 *   GET  /magnets              → list magnets
 *   POST /magnets/add          → add a magnet
 *   POST /magnets/delete       → delete a magnet
 *   GET  /classify             → classify form
 *   POST /classify             → classify a message file
 *   GET  /train                → train form (file upload + bulk import)
 *   POST /train                → train an uploaded .eml into a bucket
 *   POST /train/import         → bulk-train from training/ directory
 *   GET  /history              → recent 100 classifications
 *   POST /history/retrain     → correct a history entry's bucket
 *   GET  /api/buckets          → JSON bucket list
 *   GET  /api/stats            → JSON stats for current user
 *   GET  /metrics              → Prometheus text metrics (unauthenticated)
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes, type Stats, type WordScore } from "../classifier/Bayes.ts";

export class UIServer extends Module {
  #server: Deno.HttpServer | null = null;
  /** Maps random UI cookie token → Bayes session key. */
  #browserSessions: Map<string, string> = new Map();
  /** Maps Bayes session key → CSRF token for that session. */
  #csrfTokens: Map<string, string> = new Map();
  /** Bayes session keys whose user still has the default (blank) password. */
  #needsPasswordChange: Set<string> = new Set();
  /** Failed login attempt counts per remote IP. */
  #loginAttempts: Map<string, { count: number; until: number }> = new Map();
  /** Pre-authentication CSRF tokens for the login form: token → expiry timestamp. */
  #loginCsrfTokens: Map<string, number> = new Map();
  /** Unix ms when the server started — used for uptime in /metrics. */
  #startTime = 0;

  constructor() {
    super();
    this.name_ = "ui";
  }

  override initialize(): LifecycleResult {
    this.config_("port", "8080");
    this.config_("local", "1");
    this.config_("enabled", "1");
    this.config_("trusted_proxy", "0");
    this.config_("tls", "0");
    this.config_("tls_cert", "cert.pem");
    this.config_("tls_key", "key.pem");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    if (this.config_("enabled") === "0") return LifecycleResult.Skip;

    // Ensure classify-cache dir exists and purge entries older than 24 h
    try {
      const cacheDir = this.#cacheDir();
      Deno.mkdirSync(cacheDir, { recursive: true });
      const cutoff = Date.now() - 86_400_000;
      for (const entry of Deno.readDirSync(cacheDir)) {
        if (!entry.isFile) continue;
        try {
          const info = Deno.statSync(`${cacheDir}/${entry.name}`);
          if ((info.mtime?.getTime() ?? 0) < cutoff) {
            Deno.removeSync(`${cacheDir}/${entry.name}`);
          }
        } catch { /* ok */ }
      }
    } catch { /* non-fatal */ }

    const port = parseInt(this.config_("port"), 10);
    const hostname = this.config_("local") === "1" ? "127.0.0.1" : "0.0.0.0";
    const useTls = this.config_("tls") === "1";

    this.#startTime = Date.now();
    this.mqRegister_("TICKD", this);

    if (useTls) {
      const certPath = this.configuration_().getUserPath(this.config_("tls_cert"));
      const keyPath  = this.configuration_().getUserPath(this.config_("tls_key"));
      let cert: string, key: string;
      try {
        cert = Deno.readTextFileSync(certPath);
        key  = Deno.readTextFileSync(keyPath);
      } catch (e) {
        this.log_(0, `UI TLS: cannot read cert/key: ${e}`);
        return LifecycleResult.Fatal;
      }
      this.#server = Deno.serve(
        { port, hostname, cert, key, onListen: () => this.log_(0, `UI on https://${hostname}:${port}`) },
        (req, info) => this.#handle(req, (info.remoteAddr as Deno.NetAddr).hostname),
      );
    } else {
      this.#server = Deno.serve(
        { port, hostname, onListen: () => this.log_(0, `UI on http://${hostname}:${port}`) },
        (req, info) => this.#handle(req, (info.remoteAddr as Deno.NetAddr).hostname),
      );
    }
    return LifecycleResult.Ok;
  }

  override stop(): void {
    this.#server?.shutdown();
    // Release all Bayes sessions
    const bayes = this.getModule_<Bayes>("classifier");
    for (const bayesSession of this.#browserSessions.values()) {
      try { bayes.releaseSessionKey(bayesSession); } catch { /* ok */ }
    }
    this.#browserSessions.clear();
    this.#csrfTokens.clear();
    this.#needsPasswordChange.clear();
    this.#loginAttempts.clear();
    this.#loginCsrfTokens.clear();
    super.stop();
  }

  /**
   * Hourly TICKD: sweep stale browser sessions and expired rate-limiter entries
   * to prevent unbounded memory growth in long-running deployments.
   */
  override deliver(type: string): void {
    if (type !== "TICKD") return;
    const bayes = this.getModule_<Bayes>("classifier");

    // Remove browser session entries whose Bayes session has timed out
    for (const [token, bayesKey] of this.#browserSessions) {
      if (bayes.getUsername(bayesKey) === null) {
        this.#browserSessions.delete(token);
        this.#csrfTokens.delete(bayesKey);
        this.#needsPasswordChange.delete(bayesKey);
      }
    }

    // Remove rate-limiter entries: expired lockouts and partial-failure counts
    const now = Date.now();
    for (const [ip, entry] of this.#loginAttempts) {
      if (entry.until === 0 || now >= entry.until) {
        this.#loginAttempts.delete(ip);
      }
    }

    // Sweep expired pre-auth CSRF tokens (belt-and-suspenders alongside issue-time sweep)
    for (const [token, expiry] of this.#loginCsrfTokens) {
      if (now >= expiry) this.#loginCsrfTokens.delete(token);
    }
  }

  /** Path to the directory where uploaded .eml files are cached. */
  #cacheDir(): string {
    return this.configuration_().getUserPath("classify-cache");
  }

  /**
   * Save uploaded bytes to the classify-cache and return a UUID for lookup.
   * The file is named {uuid}.eml under the cache directory.
   */
  async #saveToCache(bytes: Uint8Array): Promise<string> {
    const id = crypto.randomUUID();
    const cacheDir = this.#cacheDir();
    Deno.mkdirSync(cacheDir, { recursive: true });
    await Deno.writeFile(`${cacheDir}/${id}.eml`, bytes);
    return id;
  }

  /**
   * Resolve a cache ID to an absolute file path.
   * Returns null if the ID is invalid or the file does not exist.
   */
  #resolveCacheId(id: string): string | null {
    // UUID format only — reject anything with path separators
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const path = `${this.#cacheDir()}/${id}.eml`;
    try { Deno.statSync(path); return path; } catch { return null; }
  }

  /** Returns the actual bound port (useful when configured with port 0). */
  getListenPort(): number {
    const addr = this.#server?.addr as Deno.NetAddr | undefined;
    return addr?.port ?? parseInt(this.config_("port"), 10);
  }

  // -------------------------------------------------------------------------
  // Auth helpers
  // -------------------------------------------------------------------------

  #getSessionFromCookie(req: Request): string | null {
    const cookieHeader = req.headers.get("cookie") ?? "";
    for (const part of cookieHeader.split(";")) {
      const [k, v] = part.trim().split("=", 2);
      if (k === "popfile_session" && v) {
        const bayesKey = this.#browserSessions.get(v);
        if (bayesKey) return bayesKey;
      }
    }
    return null;
  }

  /** Build a Set-Cookie value for the session token. Adds Secure when TLS is enabled. */
  #sessionCookie(token: string): string {
    const secure = this.config_("tls") === "1" ? "; Secure" : "";
    return `popfile_session=${token}; HttpOnly; Path=/; SameSite=Lax${secure}`;
  }

  /** Build a Set-Cookie value that clears the session cookie. */
  #clearCookie(): string {
    const secure = this.config_("tls") === "1" ? "; Secure" : "";
    return `popfile_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }

  /** Issue a single-use CSRF token for the login form (15-minute TTL). */
  #issueLoginCsrf(): string {
    // Sweep expired tokens to prevent unbounded growth
    const now = Date.now();
    for (const [t, exp] of this.#loginCsrfTokens) {
      if (now >= exp) this.#loginCsrfTokens.delete(t);
    }
    const token = this.#generateToken();
    this.#loginCsrfTokens.set(token, now + 15 * 60 * 1000);
    return token;
  }

  /** Verify and consume a login CSRF token. Returns false if missing or expired. */
  #verifyLoginCsrf(token: string): boolean {
    const exp = this.#loginCsrfTokens.get(token);
    this.#loginCsrfTokens.delete(token); // always consume — single use
    return !!exp && Date.now() < exp;
  }

  #generateToken(): string {
    const buf = new Uint8Array(24);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  #verifyCsrf(session: string, form: FormData): boolean {
    const expected = this.#csrfTokens.get(session);
    if (!expected) return false;
    const provided = form.get("_csrf");
    return typeof provided === "string" && provided === expected;
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  async #handle(req: Request, remoteIp = "unknown"): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const bayes = this.getModule_<Bayes>("classifier");

    // When running behind a trusted reverse proxy, prefer the leftmost address
    // from X-Forwarded-For over the direct connection IP.
    if (this.config_("trusted_proxy") === "1") {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) remoteIp = xff.split(",")[0].trim() || remoteIp;
    }

    try {
      // Unauthenticated routes
      if (path === "/metrics" && req.method === "GET") return this.#metricsHandler(bayes);

      // Auth routes — no session required
      if (path === "/login" && req.method === "GET") {
        const expired = url.searchParams.get("expired") === "1";
        return this.#pageLogin(expired ? "Your session has expired. Please sign in again." : undefined);
      }
      if (path === "/login" && req.method === "POST") return await this.#doLogin(req, bayes, remoteIp);
      if (path === "/logout" && req.method === "POST") return this.#doLogout(req, bayes);

      // All other routes require authentication
      const session = this.#getSessionFromCookie(req);
      if (!session) return Response.redirect(new URL("/login", req.url), 303);

      // Verify the Bayes session is still alive (may have timed out server-side)
      if (bayes.getUsername(session) === null) {
        return this.#expireSession(req, session);
      }

      // Extend expiry on every authenticated request (rolling window)
      bayes.touchSession(session);

      const isAdmin = bayes.isAdmin(session);

      // API routes (JSON)
      if (path === "/api/buckets") return this.#apiBuckets(bayes, session);

      // HTML routes
      if (path === "/api/stats") return this.#apiStats(bayes, session);

      if (path === "/" || path === "") return Response.redirect(new URL("/stats", req.url));
      if (path === "/buckets" && req.method === "GET") return this.#pageBuckets(bayes, session);
      if (path === "/buckets/create" && req.method === "POST") return await this.#createBucket(req, bayes, session);
      if (path === "/buckets/delete" && req.method === "POST") return await this.#deleteBucket(req, bayes, session);
      if (path === "/buckets/color" && req.method === "POST") return await this.#setBucketColor(req, bayes, session);
      if (path === "/magnets" && req.method === "GET") return this.#pageMagnets(bayes, session);
      if (path === "/magnets/add" && req.method === "POST") return await this.#addMagnet(req, bayes, session);
      if (path === "/magnets/delete" && req.method === "POST") return await this.#deleteMagnet(req, bayes, session);
      if (path === "/classify" && req.method === "GET") return this.#pageClassify(bayes, session);
      if (path === "/classify" && req.method === "POST") return await this.#doClassify(req, bayes, session);
      if (path === "/train" && req.method === "GET") return await this.#pageTrain(bayes, session);
      if (path === "/train" && req.method === "POST") return await this.#doTrain(req, bayes, session);
      if (path === "/train/import" && req.method === "POST") return await this.#doTrainImport(req, bayes, session);
      if (path === "/history" && req.method === "GET") return this.#pageHistory(bayes, session, url);
      if (path === "/history/export" && req.method === "GET") return this.#exportHistory(bayes, session, url);
      if (path === "/history/retrain" && req.method === "POST") return await this.#doHistoryRetrain(req, bayes, session);
      if (path === "/stats" && req.method === "GET") return this.#pageStats(bayes, session);
      if (path === "/wordscores" && req.method === "GET") return this.#pageWordScores(bayes, url, session);
      if (path === "/wordscores" && req.method === "POST") return await this.#doWordScores(req, bayes, session);
      if (path === "/settings" && req.method === "GET") {
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
        return this.#pageSettings(bayes, session);
      }
      if (path === "/settings" && req.method === "POST") {
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
        return await this.#doSettings(req, bayes, session);
      }

      // Admin-only routes
      if (path === "/users" && req.method === "GET") {
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
        return this.#pageUsers(bayes, session);
      }
      if (path === "/users/create" && req.method === "POST") {
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
        return await this.#createUser(req, bayes, session);
      }
      if (path === "/users/delete" && req.method === "POST") {
        if (!isAdmin) return new Response("Forbidden", { status: 403 });
        return await this.#deleteUser(req, bayes, session);
      }
      if (path === "/users/password" && req.method === "POST") {
        return await this.#changePassword(req, bayes, session);
      }

      return this.#html404();
    } catch (e) {
      this.log_(0, `UI error: ${e}`);
      return new Response("Internal server error", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  #pageLogin(error?: string): Response {
    const loginCsrf = this.#issueLoginCsrf();
    const body = `
      <div style="max-width:360px;margin:60px auto">
        <h2 style="margin-bottom:20px">Sign in to POPFile</h2>
        ${error ? `<div class="error" style="margin-bottom:16px">${esc(error)}</div>` : ""}
        <form method="POST" action="/login" style="display:flex;flex-direction:column;gap:12px">
          <input type="hidden" name="_login_csrf" value="${loginCsrf}">
          <label>Username
            <input type="text" name="username" autocomplete="username" required style="width:100%">
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="current-password" style="width:100%">
          </label>
          <button class="btn-primary" style="align-self:flex-start;padding:8px 24px">Sign in</button>
        </form>
        <p style="margin-top:12px;font-size:.82rem;color:#888">Default: admin / (blank password)</p>
      </div>`;
    return new Response(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Sign in — POPFile</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:system-ui,sans-serif;font-size:15px;color:#222;background:#f5f5f5;padding:24px}
        h2{font-size:1.1rem;font-weight:500}
        input[type=text],input[type=password]{padding:7px 10px;border:1px solid #ccc;border-radius:6px;font-size:.9rem;width:100%;margin-top:4px}
        label{display:flex;flex-direction:column;gap:4px;font-size:.9rem;color:#444}
        .btn-primary{background:#1a1a2e;color:#fff;border:none;padding:7px 16px;border-radius:6px;cursor:pointer;font-size:.9rem}
        .btn-primary:hover{background:#2a2a4e}
        .error{background:#fdf0ef;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;color:#c0392b;font-size:.9rem}
        p{margin-bottom:12px;color:#555;font-size:.9rem}
      </style></head><body>${body}</body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'",
        },
      }
    );
  }

  async #doLogin(req: Request, bayes: Bayes, remoteIp: string): Promise<Response> {
    if (this.#isRateLimited(remoteIp)) {
      return this.#pageLogin("Too many failed login attempts. Please try again later.");
    }

    const form = await req.formData();
    const loginCsrf = (form.get("_login_csrf") as string | null) ?? "";
    if (!this.#verifyLoginCsrf(loginCsrf)) {
      return this.#pageLogin("Invalid request. Please try again.");
    }

    const username = (form.get("username") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";

    const bayesKey = await bayes.loginUser(username, password);
    if (!bayesKey) {
      this.#recordLoginFailure(remoteIp);
      return this.#pageLogin("Invalid username or password");
    }
    this.#loginAttempts.delete(remoteIp);

    const token = this.#generateToken();
    this.#browserSessions.set(token, bayesKey);
    this.#csrfTokens.set(bayesKey, this.#generateToken());
    if (await bayes.isDefaultPassword(bayesKey)) {
      this.#needsPasswordChange.add(bayesKey);
    }

    return new Response(null, {
      status: 303,
      headers: {
        "Location": "/stats",
        "Set-Cookie": this.#sessionCookie(token),
      },
    });
  }

  #doLogout(req: Request, bayes: Bayes): Response {
    const cookieHeader = req.headers.get("cookie") ?? "";
    for (const part of cookieHeader.split(";")) {
      const [k, v] = part.trim().split("=", 2);
      if (k === "popfile_session" && v) {
        const bayesKey = this.#browserSessions.get(v);
        if (bayesKey) bayes.releaseSessionKey(bayesKey);
        this.#browserSessions.delete(v);
      }
    }
    return new Response(null, {
      status: 303,
      headers: {
        "Location": "/login",
        "Set-Cookie": this.#clearCookie(),
      },
    });
  }

  /** Called when a browser session cookie points to an expired Bayes session. */
  #expireSession(req: Request, session: string): Response {
    for (const [token, key] of this.#browserSessions) {
      if (key === session) this.#browserSessions.delete(token);
    }
    this.#csrfTokens.delete(session);
    this.#needsPasswordChange.delete(session);
    return new Response(null, {
      status: 303,
      headers: {
        "Location": new URL("/login?expired=1", req.url).toString(),
        "Set-Cookie": this.#clearCookie(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Login rate limiting
  // -------------------------------------------------------------------------

  #isRateLimited(ip: string): boolean {
    const entry = this.#loginAttempts.get(ip);
    if (!entry) return false;
    if (entry.until === 0) return false;      // threshold not yet reached
    if (Date.now() < entry.until) return true; // within lockout window
    this.#loginAttempts.delete(ip);            // lockout expired
    return false;
  }

  #recordLoginFailure(ip: string): void {
    const WINDOW = 15 * 60 * 1000; // 15 minutes
    const MAX = 10;
    const entry = this.#loginAttempts.get(ip) ?? { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= MAX) entry.until = Date.now() + WINDOW;
    this.#loginAttempts.set(ip, entry);
  }

  // -------------------------------------------------------------------------
  // Users management (admin only)
  // -------------------------------------------------------------------------

  #pageUsers(bayes: Bayes, session: string): Response {
    const users = bayes.listUsers(session);
    const rows = users.map((u) => `
      <tr>
        <td>${esc(u.name)}${u.isAdmin ? ' <span class="badge">admin</span>' : ""}</td>
        <td>
          ${!u.isAdmin ? `
          <form method="POST" action="/users/delete" style="display:inline">
            <input type="hidden" name="username" value="${esc(u.name)}">
            <button class="btn-danger" onclick="return confirm('Delete user ${esc(u.name)}?')">Delete</button>
          </form>` : ""}
        </td>
      </tr>`).join("");

    const body = `
      <h2>Users</h2>
      <table style="margin-bottom:24px">
        <thead><tr><th>Username</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h3 style="margin-bottom:12px">Create user</h3>
      <form method="POST" action="/users/create" class="inline-form">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password">
        <button class="btn-primary">Create</button>
      </form>
      <h3 style="margin-bottom:12px">Change your password</h3>
      <form method="POST" action="/users/password" class="inline-form">
        <input type="password" name="password" placeholder="New password">
        <input type="password" name="confirm" placeholder="Confirm password">
        <button class="btn-primary">Update password</button>
      </form>`;
    return this.#htmlPage("Users", body, bayes, session);
  }

  async #createUser(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const username = (form.get("username") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";
    if (username) {
      try { await bayes.createUserAccount(session, username, password); } catch (e) {
        this.log_(0, `Create user error: ${e}`);
      }
    }
    return Response.redirect(new URL("/users", req.url), 303);
  }

  async #deleteUser(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const username = (form.get("username") as string | null) ?? "";
    if (username) {
      try { bayes.deleteUserAccount(session, username); } catch (e) {
        this.log_(0, `Delete user error: ${e}`);
      }
    }
    return Response.redirect(new URL("/users", req.url), 303);
  }

  async #changePassword(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const password = (form.get("password") as string | null) ?? "";
    const confirm  = (form.get("confirm")  as string | null) ?? "";
    if (password === confirm) {
      try {
        await bayes.setPassword(session, password);
        this.#needsPasswordChange.delete(session);
      } catch (e) {
        this.log_(0, `Set password error: ${e}`);
      }
    }
    return Response.redirect(new URL("/users", req.url), 303);
  }

  // -------------------------------------------------------------------------
  // API handlers
  // -------------------------------------------------------------------------

  #apiBuckets(bayes: Bayes, session: string): Response {
    const buckets = bayes.getBuckets(session);
    const data = buckets.map((name) => ({
      name,
      wordCount: bayes.getBucketWordCount(session, name),
    }));
    return Response.json(data);
  }

  // -------------------------------------------------------------------------
  // HTML page handlers
  // -------------------------------------------------------------------------

  #pageBuckets(bayes: Bayes, session: string): Response {
    const buckets = bayes.getBuckets(session);
    const colors = bayes.getBucketColors(session);
    const rows = buckets.map((name) => {
      const wc = bayes.getBucketWordCount(session, name);
      const color = colors.get(name) ?? "black";
      return `<tr>
        <td>
          ${dot(color)}${esc(name)}
          <form method="POST" action="/buckets/color" style="display:inline;margin-left:8px">
            <input type="hidden" name="name" value="${esc(name)}">
            <input type="color" name="color" value="${colorToHex(color)}"
              title="Pick colour" style="width:28px;height:22px;padding:1px;border:1px solid #ccc;border-radius:4px;cursor:pointer;vertical-align:middle"
              onchange="this.form.submit()">
          </form>
        </td>
        <td>${wc.toLocaleString()}</td>
        <td>
          <form method="POST" action="/buckets/delete" style="display:inline">
            <input type="hidden" name="name" value="${esc(name)}">
            <button class="btn-danger" onclick="return confirm('Delete bucket ${esc(name)}?')">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const body = `
      <h2>Buckets</h2>
      <form method="POST" action="/buckets/create" class="inline-form">
        <input type="text" name="name" placeholder="New bucket name" required>
        <button class="btn-primary">Create</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Word count</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3"><em>No buckets yet.</em></td></tr>'}</tbody>
      </table>`;
    return this.#htmlPage("Buckets", body, bayes, session);
  }

  async #createBucket(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const name = (form.get("name") as string | null)?.trim();
    if (name) bayes.createBucket(session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  async #deleteBucket(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const name = form.get("name") as string | null;
    if (name) bayes.deleteBucket(session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  async #setBucketColor(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const name = (form.get("name") as string | null)?.trim();
    const color = (form.get("color") as string | null)?.trim();
    // Only accept the #rrggbb format produced by <input type="color">
    if (name && color && /^#[0-9a-fA-F]{6}$/.test(color)) bayes.setBucketColor(session, name, color);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  #pageMagnets(bayes: Bayes, session: string): Response {
    const magnets = bayes.getMagnets(session);
    const buckets = bayes.getBuckets(session);
    const magnetTypes = ["from", "to", "subject", "cc"];

    const rows = magnets.map((m) => `
      <tr>
        <td>${esc(m.type)}</td>
        <td><code>${esc(m.val)}</code></td>
        <td>${esc(m.bucketName)}</td>
        <td>
          <form method="POST" action="/magnets/delete" style="display:inline">
            <input type="hidden" name="id" value="${m.id}">
            <button class="btn-danger">Delete</button>
          </form>
        </td>
      </tr>`).join("");

    const bucketOptions = buckets.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
    const typeOptions = magnetTypes.map((t) => `<option value="${t}">${t}</option>`).join("");

    const body = `
      <h2>Magnets</h2>
      <p>Magnets are explicit rules that override Bayes classification.</p>
      <form method="POST" action="/magnets/add" class="inline-form">
        <select name="type">${typeOptions}</select>
        <input type="text" name="value" placeholder="e.g. boss@company.com" required>
        <select name="bucket">${bucketOptions}</select>
        <button class="btn-primary">Add magnet</button>
      </form>
      <table>
        <thead><tr><th>Type</th><th>Value</th><th>Bucket</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><em>No magnets.</em></td></tr>'}</tbody>
      </table>`;
    return this.#htmlPage("Magnets", body, bayes, session);
  }

  async #addMagnet(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const type = form.get("type") as string;
    const value = (form.get("value") as string)?.trim();
    const bucket = form.get("bucket") as string;
    if (type && value && bucket) bayes.addMagnet(session, bucket, type, value);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  async #deleteMagnet(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const id = parseInt(form.get("id") as string, 10);
    if (!isNaN(id)) bayes.deleteMagnet(session, id);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  #pageClassify(bayes: Bayes, session: string, opts?: { result?: string; error?: string }): Response {
    const body = `
      <h2>Classify a message</h2>
      <form method="POST" action="/classify" enctype="multipart/form-data">
        <div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
          <label>Message file (.eml):
            <input type="file" name="upload" accept=".eml,message/rfc822" required
              style="padding:6px;border:1px solid #ccc;border-radius:6px;font-size:.9rem;background:#fff">
          </label>
          <button class="btn-primary" style="align-self:flex-start">Classify</button>
        </div>
      </form>
      ${opts?.error ? `<div class="error" style="margin-top:16px">${esc(opts.error)}</div>` : ""}
      ${opts?.result ?? ""}`;
    return this.#htmlPage("Classify", body, bayes, session);
  }

  async #doClassify(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const buckets = bayes.getBuckets(session);

    // Resolve uploaded file or legacy server-path field
    let filePath: string | null = null;
    let cacheId: string | null = null;
    const upload = form.get("upload");
    if (upload instanceof File) {
      const bytes = new Uint8Array(await upload.arrayBuffer());
      try {
        cacheId = await this.#saveToCache(bytes);
        filePath = this.#resolveCacheId(cacheId);
      } catch (e) {
        return this.#pageClassify(bayes, session, { error: `Error saving upload: ${String(e)}` });
      }
    } else {
      filePath = (form.get("file") as string | null)?.trim() ?? null;
    }

    if (!filePath) return this.#pageClassify(bayes, session);

    try {
      const result = bayes.classify(session, filePath);
      const colors = bayes.getBucketColors(session);
      const scoreRows = [...result.scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([b, s]) => `<tr><td>${dot(colors.get(b) ?? "black")}${esc(b)}</td><td>${(s * 100).toFixed(4)}%</td></tr>`)
        .join("");
      const bucketOptions = buckets
        .map((b) => `<option value="${esc(b)}"${b === result.bucket ? " selected" : ""}>${esc(b)}</option>`)
        .join("");
      const resultColor = colors.get(result.bucket) ?? "black";
      const wordScoresLink = cacheId
        ? `<a href="/wordscores?id=${encodeURIComponent(cacheId)}" style="font-size:.85rem">Show word scores →</a>`
        : "";
      const trainForm = cacheId && buckets.length > 0 ? `
        <div class="train-correction">
          <p>Was this wrong? Train as:</p>
          <form method="POST" action="/train" class="inline-form">
            <input type="hidden" name="id" value="${esc(cacheId)}">
            <select name="bucket">${bucketOptions}</select>
            <button class="btn-primary">Train</button>
          </form>
        </div>` : "";
      const resultHtml = `
        <div class="result">
          <h3>Result: ${dot(resultColor)}<strong>${esc(result.bucket)}</strong>
            ${result.magnetUsed ? '<span class="badge">magnet</span>' : ""}
          </h3>
          <table>
            <thead><tr><th>Bucket</th><th>Score</th></tr></thead>
            <tbody>${scoreRows}</tbody>
          </table>
          <p style="margin-top:10px">${wordScoresLink}</p>
          ${trainForm}
        </div>`;
      return this.#pageClassify(bayes, session, { result: resultHtml });
    } catch (e) {
      return this.#pageClassify(bayes, session, { error: `Error: ${String(e)}` });
    }
  }

  async #pageTrain(
    bayes: Bayes,
    session: string,
    opts?: { message?: string; error?: string; prefillBucket?: string },
  ): Promise<Response> {
    const buckets = bayes.getBuckets(session);
    const bucketOptions = (sel?: string) =>
      buckets.map((b) => `<option value="${esc(b)}"${b === sel ? " selected" : ""}>${esc(b)}</option>`).join("");

    const notice = opts?.message
      ? `<div class="success">${esc(opts.message)}</div>`
      : opts?.error
      ? `<div class="error">${esc(opts.error)}</div>`
      : "";

    // ── Bulk import: scan {userDir}/training/ for bucket subdirs ──
    const userDir = this.configuration_().getUserPath("");
    const trainingDir = userDir.replace(/\/$/, "") + "/training";
    const importRows = await this.#scanTrainingDir(trainingDir);
    let importSection = "";
    if (importRows.length > 0) {
      const rows = importRows.map(({ name, count }) => `
        <tr>
          <td>${esc(name)}</td>
          <td>${count.toLocaleString()} .eml file${count === 1 ? "" : "s"}</td>
          <td>
            <form method="POST" action="/train/import" style="display:inline">
              <input type="hidden" name="bucket" value="${esc(name)}">
              <button class="btn-primary" style="padding:4px 12px;font-size:.85rem"
                onclick="return confirm('Train ${count} message${count === 1 ? "" : "s"} into &#39;${esc(name)}&#39;?')">
                Import
              </button>
            </form>
          </td>
        </tr>`).join("");
      importSection = `
        <section style="margin-top:28px">
          <h3>Bulk import from <code>training/</code> directory</h3>
          <p>Each subdirectory of <code>${esc(trainingDir)}</code> is treated as a bucket name.</p>
          <table style="max-width:540px">
            <thead><tr><th>Bucket</th><th>Messages</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <form method="POST" action="/train/import" style="margin-top:10px">
            <input type="hidden" name="all" value="1">
            <button class="btn-primary">Import all buckets</button>
          </form>
        </section>`;
    }

    const noBuckets = buckets.length === 0
      ? `<p style="color:#888;font-style:italic">No buckets yet — <a href="/buckets">create one first</a>.</p>`
      : "";

    const body = `
      <h2>Train</h2>
      ${notice}
      ${noBuckets}
      <section>
        <h3>Upload a message</h3>
        <p>Choose an <code>.eml</code> file from your computer and the bucket it belongs to.</p>
        <form method="POST" action="/train" enctype="multipart/form-data">
          <div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
            <label>Message file (.eml):
              <input type="file" name="upload" accept=".eml,message/rfc822" required
                style="padding:6px;border:1px solid #ccc;border-radius:6px;font-size:.9rem;background:#fff">
            </label>
            <label>Bucket:
              <select name="bucket" style="width:100%">${bucketOptions(opts?.prefillBucket)}</select>
            </label>
            <button class="btn-primary" style="align-self:flex-start">Train</button>
          </div>
        </form>
      </section>
      ${importSection}`;
    return this.#htmlPage("Train", body, bayes, session);
  }

  async #doTrain(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const bucket = (form.get("bucket") as string | null)?.trim();
    if (!bucket) return await this.#pageTrain(bayes, session);

    // File upload path
    const upload = form.get("upload");
    if (upload instanceof File) {
      try {
        const bytes = new Uint8Array(await upload.arrayBuffer());
        const tmp = await Deno.makeTempFile({ suffix: ".eml" });
        try {
          await Deno.writeFile(tmp, bytes);
          const { MailParser } = await import("../classifier/MailParser.ts");
          const parsed = new MailParser().parseFile(tmp);
          bayes.trainMessage(session, bucket, parsed);
          const name = upload.name || "message.eml";
          return await this.#pageTrain(bayes, session, {
            message: `Trained "${name}" as "${bucket}".`,
            prefillBucket: bucket,
          });
        } finally {
          await Deno.remove(tmp).catch(() => {});
        }
      } catch (e) {
        return await this.#pageTrain(bayes, session, {
          error: `Error: ${String(e)}`,
          prefillBucket: bucket,
        });
      }
    }

    // Cache-ID path (used by /classify "train correction" form)
    const id = (form.get("id") as string | null)?.trim();
    const cachedPath = id ? this.#resolveCacheId(id) : null;
    if (!cachedPath) return await this.#pageTrain(bayes, session);
    try {
      const { MailParser } = await import("../classifier/MailParser.ts");
      const parsed = new MailParser().parseFile(cachedPath);
      bayes.trainMessage(session, bucket, parsed);
      return await this.#pageTrain(bayes, session, {
        message: `Trained message as "${bucket}".`,
        prefillBucket: bucket,
      });
    } catch (e) {
      return await this.#pageTrain(bayes, session, {
        error: `Error training: ${String(e)}`,
        prefillBucket: bucket,
      });
    }
  }

  async #doTrainImport(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const importAll = form.get("all") === "1";
    const singleBucket = importAll ? null : (form.get("bucket") as string | null)?.trim();

    const userDir = this.configuration_().getUserPath("");
    const trainingDir = userDir.replace(/\/$/, "") + "/training";
    const rows = await this.#scanTrainingDir(trainingDir);
    const targets = importAll ? rows.map((r) => r.name) : (singleBucket ? [singleBucket] : []);
    if (targets.length === 0) return await this.#pageTrain(bayes, session, { error: "No buckets to import." });

    const { MailParser } = await import("../classifier/MailParser.ts");
    const parser = new MailParser();
    const results: string[] = [];

    for (const bucketName of targets) {
      // Ensure bucket exists
      const existing = bayes.getBuckets(session);
      if (!existing.includes(bucketName)) bayes.createBucket(session, bucketName);

      const dir = `${trainingDir}/${bucketName}`;
      let ok = 0, failed = 0;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isFile || !entry.name.toLowerCase().endsWith(".eml")) continue;
          try {
            const parsed = parser.parseFile(`${dir}/${entry.name}`);
            bayes.trainMessage(session, bucketName, parsed);
            ok++;
          } catch {
            failed++;
          }
        }
      } catch {
        results.push(`${bucketName}: directory not readable`);
        continue;
      }
      results.push(`${bucketName}: ${ok} trained${failed > 0 ? `, ${failed} failed` : ""}`);
    }

    return await this.#pageTrain(bayes, session, { message: results.join("; ") });
  }

  /** Scan trainingDir for subdirectories and count .eml files in each. */
  async #scanTrainingDir(trainingDir: string): Promise<Array<{ name: string; count: number }>> {
    const result: Array<{ name: string; count: number }> = [];
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(trainingDir)) entries.push(e);
    } catch {
      return [];
    }
    for (const entry of entries.filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
      let count = 0;
      try {
        for await (const f of Deno.readDir(`${trainingDir}/${entry.name}`)) {
          if (f.isFile && f.name.toLowerCase().endsWith(".eml")) count++;
        }
      } catch { /* skip unreadable */ }
      result.push({ name: entry.name, count });
    }
    return result;
  }

  #pageHistory(bayes: Bayes, session: string, url: URL): Response {
    const PAGE_SIZE = 25;
    const page    = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const bucket  = url.searchParams.get("bucket")?.trim() || undefined;
    const search  = url.searchParams.get("q")?.trim() || undefined;
    const offset  = (page - 1) * PAGE_SIZE;

    const filterOpts = { bucket, search };
    const total   = bayes.getHistoryCount(session, filterOpts);
    const history = bayes.getHistory(session, { limit: PAGE_SIZE, offset, ...filterOpts });
    const buckets = bayes.getBuckets(session);
    const colors  = bayes.getBucketColors(session);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Build a query-string preserving current filters but overriding page
    const qs = (p: number) => {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (search) params.set("q", search);
      if (p > 1) params.set("page", String(p));
      const s = params.toString();
      return s ? `?${s}` : "";
    };

    const bucketOptions = (selected: string) => buckets
      .map((b) => `<option value="${esc(b)}"${b === selected ? " selected" : ""}>${esc(b)}</option>`)
      .join("");

    // ── Filter bar ──────────────────────────────────────────────────────────
    const allBuckets = ["unclassified", ...buckets];
    const filterBucketOpts = allBuckets
      .map((b) => `<option value="${esc(b)}"${b === bucket ? " selected" : ""}>${esc(b)}</option>`)
      .join("");
    const exportQs = (() => {
      const p = new URLSearchParams();
      if (bucket) p.set("bucket", bucket);
      if (search) p.set("q", search);
      const s = p.toString();
      return s ? `?${s}` : "";
    })();
    const filterBar = `
      <form method="GET" action="/history" class="inline-form" style="margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <select name="bucket" style="font-size:.9rem;padding:6px 8px">
          <option value="">All buckets</option>
          ${filterBucketOpts}
        </select>
        <input type="text" name="q" value="${esc(search ?? "")}" placeholder="Search subject / from…"
          style="width:220px">
        <button class="btn-primary">Filter</button>
        ${bucket || search ? `<a href="/history" style="font-size:.85rem;color:#888;line-height:2">Clear</a>` : ""}
        <a href="/history/export${exportQs}"
          style="margin-left:auto;font-size:.85rem;background:#2c7a4b;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none">
          Export CSV
        </a>
      </form>`;

    // ── Table rows ───────────────────────────────────────────────────────────
    const rows = history.map((h) => {
      const date = new Date(h.date * 1000).toLocaleString();
      const color = colors.get(h.bucket) ?? "black";
      const corrected = h.usedtobe
        ? `<span title="Corrected from ${esc(h.usedtobe)}" style="color:#888;font-size:.8rem"> (was ${dot(colors.get(h.usedtobe) ?? "black")}${esc(h.usedtobe)})</span>`
        : "";
      // Retrain form carries back=... so redirect preserves filter state
      const back = encodeURIComponent(`/history${qs(page)}`);
      return `<tr>
        <td style="white-space:nowrap;font-size:.85rem">${date}</td>
        <td>${esc(h.subject || "(no subject)")}</td>
        <td style="font-size:.85rem">${esc(h.fromAddress)}</td>
        <td>${dot(color)}${esc(h.bucket)}${h.magnetUsed ? ' <span class="badge">magnet</span>' : ""}${corrected}</td>
        <td>
          <form method="POST" action="/history/retrain" class="inline-form" style="margin:0">
            <input type="hidden" name="id" value="${h.id}">
            <input type="hidden" name="back" value="${esc(decodeURIComponent(back))}">
            <select name="bucket" style="font-size:.8rem;padding:4px 6px">${bucketOptions(h.bucket)}</select>
            <button class="btn-primary" style="padding:4px 10px;font-size:.8rem">Retrain</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    // ── Pagination bar ───────────────────────────────────────────────────────
    const prevLink = page > 1
      ? `<a href="/history${qs(page - 1)}" style="padding:5px 12px;background:#fff;border:1px solid #ccc;border-radius:6px;text-decoration:none;font-size:.9rem">← Prev</a>`
      : `<span style="padding:5px 12px;border:1px solid #eee;border-radius:6px;color:#bbb;font-size:.9rem">← Prev</span>`;
    const nextLink = page < totalPages
      ? `<a href="/history${qs(page + 1)}" style="padding:5px 12px;background:#fff;border:1px solid #ccc;border-radius:6px;text-decoration:none;font-size:.9rem">Next →</a>`
      : `<span style="padding:5px 12px;border:1px solid #eee;border-radius:6px;color:#bbb;font-size:.9rem">Next →</span>`;
    const pageInfo = `<span style="font-size:.9rem;color:#666">Page ${page} of ${totalPages} &nbsp;·&nbsp; ${total.toLocaleString()} message${total === 1 ? "" : "s"}</span>`;
    const pagination = totalPages > 1 || total > 0
      ? `<div style="display:flex;align-items:center;gap:12px;margin-top:16px">${prevLink}${pageInfo}${nextLink}</div>`
      : "";

    const heading = `History${bucket ? ` — ${esc(bucket)}` : ""}${search ? ` matching "${esc(search)}"` : ""}`;
    const body = `
      <h2>${heading}</h2>
      ${filterBar}
      ${history.length === 0
        ? '<p style="color:#888">No matching classifications.</p>'
        : `<table>
            <thead><tr>
              <th>Date</th><th>Subject</th><th>From</th><th>Classification</th><th>Correct to</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      ${pagination}`;
    return this.#htmlPage("History", body, bayes, session);
  }

  #exportHistory(bayes: Bayes, session: string, url: URL): Response {
    const bucket = url.searchParams.get("bucket")?.trim() || undefined;
    const search = url.searchParams.get("q")?.trim() || undefined;
    const history = bayes.getHistory(session, { limit: 100_000, offset: 0, bucket, search });

    const csvEscape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [
      ["id", "date", "from", "subject", "bucket", "was_bucket", "magnet"].join(","),
      ...history.map((h) => [
        h.id,
        new Date(h.date * 1000).toISOString(),
        csvEscape(h.fromAddress),
        csvEscape(h.subject),
        csvEscape(h.bucket),
        csvEscape(h.usedtobe ?? ""),
        h.magnetUsed ? "1" : "0",
      ].join(",")),
    ];
    return new Response(lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="popfile-history.csv"`,
      },
    });
  }

  async #doHistoryRetrain(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const id = parseInt(form.get("id") as string, 10);
    const bucket = (form.get("bucket") as string)?.trim();
    const back = (form.get("back") as string | null)?.trim() || "/history";
    if (!isNaN(id) && bucket) {
      try {
        bayes.retrainHistory(session, id, bucket);
      } catch (e) {
        this.log_(0, `Retrain error: ${e}`);
      }
    }
    return Response.redirect(new URL(back, req.url), 303);
  }

  // -------------------------------------------------------------------------
  // Stats page
  // -------------------------------------------------------------------------

  #apiStats(bayes: Bayes, session: string): Response {
    return Response.json(bayes.getStats(session));
  }

  #metricsHandler(bayes: Bayes): Response {
    const m = bayes.getGlobalMetrics();
    const uptimeSeconds = Math.floor((Date.now() - this.#startTime) / 1000);

    const lines: string[] = [
      "# HELP popfile_classified_total Total messages classified",
      "# TYPE popfile_classified_total counter",
      `popfile_classified_total ${m.totalClassified}`,
      "# HELP popfile_retrained_total Total messages manually retrained",
      "# TYPE popfile_retrained_total counter",
      `popfile_retrained_total ${m.totalRetrained}`,
      "# HELP popfile_magnet_hits_total Total classifications via magnet rules",
      "# TYPE popfile_magnet_hits_total counter",
      `popfile_magnet_hits_total ${m.magnetHits}`,
      "# HELP popfile_words_trained_total Words trained per bucket",
      "# TYPE popfile_words_trained_total gauge",
      ...m.buckets.map(b => `popfile_words_trained_total{bucket="${b.name}"} ${b.wordCount}`),
      "# HELP popfile_classified_by_bucket_total Messages classified per bucket",
      "# TYPE popfile_classified_by_bucket_total counter",
      ...m.buckets.map(b => `popfile_classified_by_bucket_total{bucket="${b.name}"} ${b.classifiedCount}`),
      "# HELP popfile_uptime_seconds Seconds since the server started",
      "# TYPE popfile_uptime_seconds gauge",
      `popfile_uptime_seconds ${uptimeSeconds}`,
    ];

    return new Response(lines.join("\n") + "\n", {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  }

  #pageStats(bayes: Bayes, session: string): Response {
    const s = bayes.getStats(session);
    const accuracy = s.totalClassified > 0
      ? (((s.totalClassified - s.totalRetrained) / s.totalClassified) * 100).toFixed(1)
      : null;

    const cards = [
      ["Classified", s.totalClassified.toLocaleString(), "#1a1a2e"],
      ["Total words", s.totalWords.toLocaleString(), "#2c7a4b"],
      ["Magnet hits", s.magnetHits.toLocaleString(), "#2980b9"],
      ["Accuracy", accuracy !== null ? `${accuracy}%` : "—", "#7d3c98"],
    ].map(([label, value, color]) => `
      <div style="background:#fff;border-radius:8px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.08);min-width:140px;flex:1">
        <div style="font-size:2rem;font-weight:600;color:${color}">${value}</div>
        <div style="font-size:.85rem;color:#666;margin-top:4px">${label}</div>
      </div>`).join("");

    const maxWords = Math.max(1, ...s.buckets.map((b) => b.wordCount));
    const maxClassified = Math.max(1, ...s.buckets.map((b) => b.classifiedCount));

    const bucketRows = s.buckets.map((b) => {
      const wordPct = (b.wordCount / maxWords * 100).toFixed(1);
      const clsPct  = (b.classifiedCount / maxClassified * 100).toFixed(1);
      return `<tr>
        <td>${dot(b.color)}${esc(b.name)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#eee;border-radius:3px;height:10px;min-width:80px">
              <div style="width:${wordPct}%;background:#2c7a4b;height:10px;border-radius:3px"></div>
            </div>
            <span style="min-width:60px;text-align:right;font-size:.85rem">${b.wordCount.toLocaleString()}</span>
          </div>
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#eee;border-radius:3px;height:10px;min-width:80px">
              <div style="width:${clsPct}%;background:#2980b9;height:10px;border-radius:3px"></div>
            </div>
            <span style="min-width:40px;text-align:right;font-size:.85rem">${b.classifiedCount.toLocaleString()}</span>
          </div>
        </td>
      </tr>`;
    }).join("");

    const retrainNote = s.totalRetrained > 0
      ? `<p style="margin-top:8px;font-size:.85rem;color:#888">${s.totalRetrained.toLocaleString()} message${s.totalRetrained === 1 ? "" : "s"} retrained after classification.</p>`
      : "";

    const body = `
      <h2>Statistics</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:28px">${cards}</div>
      ${retrainNote}
      ${s.buckets.length === 0
        ? '<p>No buckets yet. <a href="/buckets">Create one</a> to get started.</p>'
        : `<h3 style="margin-bottom:12px">Per-bucket breakdown</h3>
           <table>
             <thead><tr><th>Bucket</th><th>Words trained</th><th>Messages classified</th></tr></thead>
             <tbody>${bucketRows}</tbody>
           </table>`}`;

    return this.#htmlPage("Stats", body, bayes, session);
  }

  // -------------------------------------------------------------------------
  // Word scores page
  // -------------------------------------------------------------------------

  #pageWordScores(bayes: Bayes, url: URL, session: string, opts?: { error?: string }): Response {
    const buckets = bayes.getBuckets(session);
    const colors  = bayes.getBucketColors(session);

    // Resolve file: ?id=<uuid> only — direct server paths are not accepted
    const cacheId = url.searchParams.get("id")?.trim() ?? "";
    const filePath = cacheId ? this.#resolveCacheId(cacheId) : null;

    let resultHtml = "";
    if (cacheId && !filePath) {
      resultHtml = `<div class="error">This file is no longer available (it may have expired). Please re-upload below.</div>`;
    } else if (filePath) {
      try {
        const result = bayes.classifyWithWordScores(session, filePath);
        const resultColor = colors.get(result.bucket) ?? "black";
        const scoreRows = [...result.scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([b, s]) => `<tr><td>${dot(colors.get(b) ?? "black")}${esc(b)}</td><td>${(s * 100).toFixed(2)}%</td></tr>`)
          .join("");
        const wordRows = this.#renderWordRows(result.wordScores, buckets, colors);
        resultHtml = `
          <div class="result" style="margin-bottom:24px">
            <h3>Classification: ${dot(resultColor)}<strong>${esc(result.bucket)}</strong>
              ${result.magnetUsed ? '<span class="badge">magnet</span>' : ""}
            </h3>
            <table style="max-width:360px;margin-bottom:0">
              <thead><tr><th>Bucket</th><th>Score</th></tr></thead>
              <tbody>${scoreRows}</tbody>
            </table>
          </div>
          ${result.wordScores.length === 0
            ? '<p>No trained words found in this message.</p>'
            : `<h3 style="margin-bottom:12px">Top discriminating words</h3>
               <table>
                 <thead><tr>
                   <th>Word</th><th>Count</th>
                   ${buckets.map((b) => `<th>${dot(colors.get(b) ?? "black")}${esc(b)}</th>`).join("")}
                   <th>Pushes toward</th>
                 </tr></thead>
                 <tbody>${wordRows}</tbody>
               </table>`}`;
      } catch (e) {
        resultHtml = `<div class="error">Error: ${esc(String(e))}</div>`;
      }
    }

    const notice = opts?.error ? `<div class="error" style="margin-bottom:16px">${esc(opts.error)}</div>` : "";

    const body = `
      <h2>Word scores</h2>
      <p>Shows which words most influenced the classification of a message.</p>
      ${notice}
      <form method="POST" action="/wordscores" enctype="multipart/form-data">
        <div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
          <label>Message file (.eml):
            <input type="file" name="upload" accept=".eml,message/rfc822" required
              style="padding:6px;border:1px solid #ccc;border-radius:6px;font-size:.9rem;background:#fff">
          </label>
          <button class="btn-primary" style="align-self:flex-start">Analyse</button>
        </div>
      </form>
      ${resultHtml}`;
    return this.#htmlPage("Word scores", body, bayes, session);
  }

  async #doWordScores(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const upload = form.get("upload");
    if (!(upload instanceof File)) {
      return this.#pageWordScores(bayes, new URL(req.url), session, { error: "No file uploaded." });
    }
    try {
      const bytes = new Uint8Array(await upload.arrayBuffer());
      const id = await this.#saveToCache(bytes);
      return Response.redirect(new URL(`/wordscores?id=${encodeURIComponent(id)}`, req.url), 303);
    } catch (e) {
      return this.#pageWordScores(bayes, new URL(req.url), session, { error: `Error: ${String(e)}` });
    }
  }

  #renderWordRows(
    wordScores: WordScore[],
    buckets: string[],
    colors: Map<string, string>,
  ): string {
    // Find the max probability across all words/buckets for bar scaling
    let maxProb = 0;
    for (const ws of wordScores) {
      for (const p of ws.bucketProbs.values()) if (p > maxProb) maxProb = p;
    }
    if (maxProb === 0) maxProb = 1;

    return wordScores.map((ws) => {
      const probCells = buckets.map((b) => {
        const p = ws.bucketProbs.get(b) ?? 0;
        const pct = (p / maxProb * 100).toFixed(1);
        const color = colors.get(b) ?? "#888";
        return `<td>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="width:64px;background:#eee;border-radius:3px;height:8px">
              <div style="width:${pct}%;background:${esc(color)};height:8px;border-radius:3px"></div>
            </div>
            <span style="font-size:.8rem;min-width:40px">${(p * 100).toFixed(3)}%</span>
          </div>
        </td>`;
      }).join("");

      const topColor = colors.get(ws.topBucket) ?? "black";
      return `<tr>
        <td><code>${esc(ws.word)}</code></td>
        <td style="text-align:center">${ws.freq}</td>
        ${probCells}
        <td>${dot(topColor)}${esc(ws.topBucket)}</td>
      </tr>`;
    }).join("");
  }

  // -------------------------------------------------------------------------
  // Settings page
  // -------------------------------------------------------------------------

  #pageSettings(bayes: Bayes, session: string, saved = false): Response {
    const cfg = this.configuration_();

    const sections: Array<{
      title: string;
      note?: string;
      fields: Array<{ key: string; label: string; type: "text" | "number" | "password" | "checkbox"; hint?: string }>;
    }> = [
      {
        title: "Classifier",
        fields: [
          { key: "classifier_unclassified_weight", label: "Unclassified weight", type: "number",
            hint: "Higher = more messages fall through as unclassified (default 100)" },
          { key: "GLOBAL_message_cutoff", label: "Message size cutoff (chars)", type: "number",
            hint: "Body text beyond this limit is ignored (default 100000)" },
        ],
      },
      {
        title: "Security",
        note: "TLS changes require restart to take effect.",
        fields: [
          { key: "GLOBAL_session_timeout", label: "Session timeout (seconds)", type: "number",
            hint: "Idle sessions expire after this many seconds; activity resets the timer (default 1800)" },
          { key: "ui_trusted_proxy", label: "Trust X-Forwarded-For", type: "checkbox",
            hint: "Enable when running behind a reverse proxy (nginx, Caddy, Traefik) so login rate-limiting uses the real client IP" },
          { key: "ui_tls", label: "Enable HTTPS (TLS)", type: "checkbox",
            hint: "Serve the web UI over HTTPS; requires cert and key files below" },
          { key: "ui_tls_cert", label: "Certificate file", type: "text",
            hint: "Path to PEM certificate (default cert.pem in data directory)" },
          { key: "ui_tls_key", label: "Private key file", type: "text",
            hint: "Path to PEM private key (default key.pem in data directory)" },
        ],
      },
      {
        title: "POP3 proxy",
        note: "Requires restart to take effect.",
        fields: [
          { key: "pop3_port",  label: "Listen port",        type: "number", hint: "Default 1110" },
          { key: "pop3_local", label: "Localhost only",     type: "checkbox" },
        ],
      },
      {
        title: "POP3S proxy",
        note: "Requires restart to take effect.",
        fields: [
          { key: "pop3s_port", label: "Listen port", type: "number", hint: "Default 1995" },
        ],
      },
      {
        title: "SMTP proxy",
        note: "Set upstream server to enable. Requires restart to take effect.",
        fields: [
          { key: "smtp_server",      label: "Upstream server",      type: "text",     hint: "Hostname — leave empty to disable" },
          { key: "smtp_server_port", label: "Upstream port",        type: "number",   hint: "Default 25" },
          { key: "smtp_tls",         label: "Upstream TLS",         type: "checkbox" },
          { key: "smtp_port",        label: "Listen port",          type: "number",   hint: "Default 1025" },
          { key: "smtp_local",       label: "Localhost only",       type: "checkbox" },
        ],
      },
      {
        title: "NNTP proxy",
        note: "Set upstream server to enable. Requires restart to take effect.",
        fields: [
          { key: "nntp_server",      label: "Upstream server",      type: "text",     hint: "Hostname — leave empty to disable" },
          { key: "nntp_server_port", label: "Upstream port",        type: "number",   hint: "Default 119" },
          { key: "nntp_tls",         label: "Upstream TLS",         type: "checkbox" },
          { key: "nntp_port",        label: "Listen port",          type: "number",   hint: "Default 1119" },
        ],
      },
      {
        title: "IMAP service",
        note: "Set server to enable. Changes to server/credentials take effect on the next poll cycle.",
        fields: [
          { key: "imap_server",        label: "Server",               type: "text",     hint: "Hostname — leave empty to disable" },
          { key: "imap_port",          label: "Port",                 type: "number",   hint: "Default 143 (use 993 with TLS)" },
          { key: "imap_tls",           label: "TLS",                  type: "checkbox" },
          { key: "imap_username",      label: "Username",             type: "text" },
          { key: "imap_password",      label: "Password",             type: "password" },
          { key: "imap_watch_folder",  label: "Watch folder",         type: "text",     hint: "Default INBOX" },
          { key: "imap_move",          label: "Move to bucket folders", type: "checkbox" },
          { key: "imap_folder_prefix", label: "Folder prefix",        type: "text",     hint: "Prepended to bucket name, e.g. POPFile" },
          { key: "imap_interval",      label: "Poll interval (seconds)", type: "number", hint: "Default 60" },
        ],
      },
      {
        title: "Web UI",
        note: "Requires restart to take effect.",
        fields: [
          { key: "ui_port",  label: "Listen port",    type: "number", hint: "Default 8080" },
          { key: "ui_local", label: "Localhost only", type: "checkbox" },
        ],
      },
      {
        title: "Logging",
        fields: [
          { key: "logger_log_level", label: "Log level", type: "number",
            hint: "0 = errors only, 1 = verbose, 2 = debug" },
        ],
      },
    ];

    const sectionHtml = sections.map(({ title, note, fields }) => {
      const fieldHtml = fields.map(({ key, label, type, hint }) => {
        const val = cfg.parameter(key);
        let input: string;
        if (type === "checkbox") {
          const checked = val === "1" ? " checked" : "";
          input = `<input type="checkbox" name="${esc(key)}" value="1"${checked} style="width:auto;margin-top:4px">`;
        } else {
          input = `<input type="${type}" name="${esc(key)}" value="${esc(type === "password" ? "" : val)}"
            ${type === "number" ? 'style="width:120px"' : 'style="width:320px"'} autocomplete="off">`;
        }
        return `<div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:14px">
          <label style="min-width:220px;font-size:.9rem;padding-top:6px">${esc(label)}</label>
          <div>
            ${input}
            ${hint ? `<div style="font-size:.78rem;color:#888;margin-top:3px">${esc(hint)}</div>` : ""}
          </div>
        </div>`;
      }).join("");

      return `<fieldset style="border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin-bottom:20px">
        <legend style="font-weight:500;padding:0 6px;font-size:.95rem">${esc(title)}</legend>
        ${note ? `<p style="font-size:.82rem;color:#888;margin-bottom:14px">${esc(note)}</p>` : ""}
        ${fieldHtml}
      </fieldset>`;
    }).join("");

    const savedBanner = saved
      ? `<div class="success" style="margin-bottom:16px">Settings saved. Some changes require a restart to take effect.</div>`
      : "";

    const body = `
      <h2>Settings</h2>
      ${savedBanner}
      <form method="POST" action="/settings">
        ${sectionHtml}
        <button class="btn-primary" style="margin-top:4px">Save settings</button>
      </form>`;
    return this.#htmlPage("Settings", body, bayes, session);
  }

  async #doSettings(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    if (!this.#verifyCsrf(session, form)) return new Response("Invalid CSRF token", { status: 403 });
    const cfg = this.configuration_();

    const allKeys = [
      "classifier_unclassified_weight",
      "GLOBAL_message_cutoff",
      "GLOBAL_session_timeout",
      "ui_trusted_proxy",
      "ui_tls", "ui_tls_cert", "ui_tls_key",
      "pop3_port", "pop3_local",
      "pop3s_port",
      "smtp_server", "smtp_server_port", "smtp_tls", "smtp_port", "smtp_local",
      "nntp_server", "nntp_server_port", "nntp_tls", "nntp_port",
      "imap_server", "imap_port", "imap_tls", "imap_username", "imap_password",
      "imap_watch_folder", "imap_move", "imap_folder_prefix", "imap_interval",
      "ui_port", "ui_local",
      "logger_log_level",
    ];

    const checkboxKeys = new Set([
      "ui_trusted_proxy", "ui_tls",
      "pop3_local", "smtp_tls", "smtp_local", "nntp_tls",
      "imap_tls", "imap_move", "ui_local",
    ]);

    for (const key of allKeys) {
      if (checkboxKeys.has(key)) {
        // Unchecked checkbox → absent from form data → "0"
        cfg.parameter(key, form.has(key) ? "1" : "0");
      } else {
        const val = (form.get(key) as string | null)?.trim();
        if (val !== null && val !== undefined) {
          // Skip empty password field — keeps existing value
          if (key === "imap_password" && val === "") continue;
          cfg.parameter(key, val);
        }
      }
    }

    return this.#pageSettings(bayes, session, true);
  }

  #html404(): Response {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // -------------------------------------------------------------------------
  // HTML template
  // -------------------------------------------------------------------------

  #htmlPage(title: string, content: string, bayes: Bayes, session: string): Response {
    const isAdmin = bayes.isAdmin(session);
    const username = bayes.getUsername(session) ?? "?";
    const csrfToken = this.#csrfTokens.get(session) ?? "";
    const passwordWarning = this.#needsPasswordChange.has(session)
      ? `<div class="warning" style="margin-bottom:16px">
           Default password is still in use. <a href="/users" style="color:#7d6608;font-weight:500">Please change it.</a>
         </div>`
      : "";

    const navLinks = [
      ["Stats", "/stats"],
      ["Buckets", "/buckets"],
      ["Magnets", "/magnets"],
      ["Classify", "/classify"],
      ["Word scores", "/wordscores"],
      ["Train", "/train"],
      ["History", "/history"],
      ["Settings", "/settings"],
      ...(isAdmin ? [["Users", "/users"]] : []),
    ] as [string, string][];

    const navItems = navLinks.map(([label, href]) => `<a href="${href}">${label}</a>`).join(" | ");

    const userBar = `
      <span style="margin-left:auto;font-size:.85rem;color:#aaa;display:flex;align-items:center;gap:12px">
        ${esc(username)}${isAdmin ? ' <span style="font-size:.75rem;background:#2980b9;color:#fff;padding:1px 7px;border-radius:10px">admin</span>' : ""}
        <form method="POST" action="/logout" style="display:inline;margin:0">
          <button style="background:transparent;border:1px solid #556;color:#aaa;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:.82rem">Sign out</button>
        </form>
      </span>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${esc(csrfToken)}">
  <title>${esc(title)} — POPFile</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;font-size:15px;color:#222;background:#f5f5f5;padding:24px}
    header{background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:8px;margin-bottom:24px;display:flex;align-items:center;gap:24px}
    header h1{font-size:1.2rem;font-weight:500}
    nav a{color:#cdd;text-decoration:none;font-size:.95rem}
    nav a:hover{color:#fff}
    h2{margin-bottom:16px;font-size:1.1rem;font-weight:500}
    h3{margin:12px 0 8px;font-size:1rem}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #eee;font-size:.9rem}
    th{background:#f0f0f0;font-weight:500}
    tr:last-child td{border-bottom:none}
    .inline-form{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
    input[type=text]{padding:7px 10px;border:1px solid #ccc;border-radius:6px;font-size:.9rem}
    select{padding:7px 10px;border:1px solid #ccc;border-radius:6px;font-size:.9rem}
    .btn-primary{background:#1a1a2e;color:#fff;border:none;padding:7px 16px;border-radius:6px;cursor:pointer;font-size:.9rem}
    .btn-primary:hover{background:#2a2a4e}
    .btn-danger{background:#c0392b;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:.85rem}
    .btn-danger:hover{background:#e74c3c}
    .result{background:#fff;border-radius:8px;padding:16px;margin-top:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .badge{background:#2980b9;color:#fff;font-size:.75rem;padding:2px 8px;border-radius:10px;margin-left:8px;vertical-align:middle}
    .error{background:#fdf0ef;border-left:3px solid #c0392b;padding:12px 16px;border-radius:4px;margin-top:12px;color:#c0392b}
    .success{background:#edfaf1;border-left:3px solid #27ae60;padding:12px 16px;border-radius:4px;margin-bottom:16px;color:#1e8449}
    .warning{background:#fef9e7;border-left:3px solid #f39c12;padding:12px 16px;border-radius:4px;color:#7d6608}
    .train-correction{margin-top:16px;padding-top:12px;border-top:1px solid #eee}
    p{margin-bottom:12px;color:#555;font-size:.9rem}
    code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:.85rem}
    label{display:flex;flex-direction:column;gap:4px;font-size:.9rem;color:#444}
  </style>
</head>
<body>
  <header>
    <h1>POPFile</h1>
    <nav>${navItems}</nav>
    ${userBar}
  </header>
  <main>${passwordWarning}${content}</main>
  <script>
    (function(){
      var t=document.querySelector('meta[name="csrf-token"]').getAttribute('content');
      document.querySelectorAll('form').forEach(function(f){
        if(f.method.toUpperCase()==='POST'){
          var i=document.createElement('input');
          i.type='hidden';i.name='_csrf';i.value=t;f.appendChild(i);
        }
      });
    })();
  </script>
</body>
</html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      },
    });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dot(color: string): string {
  // colorToHex normalises to #rrggbb or falls back to #000000 — safe in CSS context
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorToHex(color)};margin-right:5px;vertical-align:middle"></span>`;
}

/** Convert a CSS colour name or hex value to a 6-digit hex string for <input type=color>. */
function colorToHex(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  // Map common CSS colour names to hex
  const names: Record<string, string> = {
    black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
    pink: "#ffc0cb", cyan: "#00ffff", magenta: "#ff00ff", grey: "#808080",
    gray: "#808080", brown: "#a52a2a", navy: "#000080", teal: "#008080",
  };
  return names[color.toLowerCase()] ?? "#000000";
}
