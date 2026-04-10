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
 *   GET  /train                → train form
 *   POST /train                → train a message file into a bucket
 *   GET  /history              → recent 100 classifications
 *   POST /history/retrain     → correct a history entry's bucket
 *   GET  /api/buckets          → JSON bucket list
 *   GET  /api/classify?file=   → JSON classify result
 *   POST /api/train            → JSON train endpoint
 */

import { Module, LifecycleResult } from "../core/Module.ts";
import { Bayes, type Stats, type WordScore } from "../classifier/Bayes.ts";

export class UIServer extends Module {
  #server: Deno.HttpServer | null = null;
  /** Maps random UI cookie token → Bayes session key. */
  #browserSessions: Map<string, string> = new Map();

  constructor() {
    super();
    this.name_ = "ui";
  }

  override initialize(): LifecycleResult {
    this.config_("port", "8080");
    this.config_("local", "1");
    this.config_("enabled", "1");
    return LifecycleResult.Ok;
  }

  override start(): LifecycleResult {
    if (this.config_("enabled") === "0") return LifecycleResult.Skip;

    const port = parseInt(this.config_("port"), 10);
    const hostname = this.config_("local") === "1" ? "127.0.0.1" : "0.0.0.0";

    this.#server = Deno.serve(
      { port, hostname, onListen: () => this.log_(0, `UI on http://${hostname}:${port}`) },
      (req) => this.#handle(req),
    );
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
    super.stop();
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

  #generateToken(): string {
    const buf = new Uint8Array(24);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const bayes = this.getModule_<Bayes>("classifier");

    try {
      // Auth routes — no session required
      if (path === "/login" && req.method === "GET")  return this.#pageLogin();
      if (path === "/login" && req.method === "POST") return await this.#doLogin(req, bayes);
      if (path === "/logout" && req.method === "POST") return this.#doLogout(req, bayes);

      // All other routes require authentication
      const session = this.#getSessionFromCookie(req);
      if (!session) return Response.redirect(new URL("/login", req.url), 303);

      const isAdmin = bayes.isAdmin(session);

      // API routes (JSON)
      if (path === "/api/buckets") return this.#apiBuckets(bayes, session);
      if (path === "/api/classify") return await this.#apiClassify(url, bayes, session);
      if (path === "/api/train" && req.method === "POST") return await this.#apiTrain(req, bayes, session);

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
      if (path === "/train" && req.method === "GET") return this.#pageTrain(bayes, session);
      if (path === "/train" && req.method === "POST") return await this.#doTrain(req, bayes, session);
      if (path === "/history" && req.method === "GET") return this.#pageHistory(bayes, session);
      if (path === "/history/retrain" && req.method === "POST") return await this.#doHistoryRetrain(req, bayes, session);
      if (path === "/stats" && req.method === "GET") return this.#pageStats(bayes, session);
      if (path === "/wordscores" && req.method === "GET") return this.#pageWordScores(bayes, url, session);
      if (path === "/settings" && req.method === "GET") return this.#pageSettings(bayes, session);
      if (path === "/settings" && req.method === "POST") return await this.#doSettings(req, bayes, session);

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
      return new Response(`Internal error: ${e}`, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  #pageLogin(error?: string): Response {
    const body = `
      <div style="max-width:360px;margin:60px auto">
        <h2 style="margin-bottom:20px">Sign in to POPFile</h2>
        ${error ? `<div class="error" style="margin-bottom:16px">${esc(error)}</div>` : ""}
        <form method="POST" action="/login" style="display:flex;flex-direction:column;gap:12px">
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
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  async #doLogin(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const username = (form.get("username") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";

    const bayesKey = bayes.loginUser(username, password);
    if (!bayesKey) return this.#pageLogin("Invalid username or password");

    const token = this.#generateToken();
    this.#browserSessions.set(token, bayesKey);

    return new Response(null, {
      status: 303,
      headers: {
        "Location": "/stats",
        "Set-Cookie": `popfile_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
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
        "Set-Cookie": "popfile_session=; HttpOnly; Path=/; Max-Age=0",
      },
    });
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
    const username = (form.get("username") as string | null)?.trim() ?? "";
    const password = (form.get("password") as string | null) ?? "";
    if (username) {
      try { bayes.createUserAccount(session, username, password); } catch (e) {
        this.log_(0, `Create user error: ${e}`);
      }
    }
    return Response.redirect(new URL("/users", req.url), 303);
  }

  async #deleteUser(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
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
    const password = (form.get("password") as string | null) ?? "";
    const confirm  = (form.get("confirm")  as string | null) ?? "";
    if (password === confirm) {
      try { bayes.setPassword(session, password); } catch (e) {
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

  async #apiTrain(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const { file, bucket } = await req.json();
    if (!file || !bucket) return Response.json({ error: "Missing file or bucket" }, { status: 400 });
    try {
      const { MailParser } = await import("../classifier/MailParser.ts");
      const parsed = new MailParser().parseFile(file);
      bayes.trainMessage(session, bucket, parsed);
      return Response.json({ ok: true, file, bucket });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
  }

  async #apiClassify(url: URL, bayes: Bayes, session: string): Promise<Response> {
    const file = url.searchParams.get("file");
    if (!file) return Response.json({ error: "Missing ?file=" }, { status: 400 });
    try {
      const result = bayes.classify(session, file);
      return Response.json({
        bucket: result.bucket,
        magnetUsed: result.magnetUsed,
        scores: Object.fromEntries(result.scores),
      });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
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
    const name = (form.get("name") as string | null)?.trim();
    if (name) bayes.createBucket(session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  async #deleteBucket(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const name = form.get("name") as string | null;
    if (name) bayes.deleteBucket(session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  async #setBucketColor(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const name = (form.get("name") as string | null)?.trim();
    const color = (form.get("color") as string | null)?.trim();
    if (name && color) bayes.setBucketColor(session, name, color);
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
    const type = form.get("type") as string;
    const value = (form.get("value") as string)?.trim();
    const bucket = form.get("bucket") as string;
    if (type && value && bucket) bayes.addMagnet(session, bucket, type, value);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  async #deleteMagnet(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const id = parseInt(form.get("id") as string, 10);
    if (!isNaN(id)) bayes.deleteMagnet(session, id);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  #pageClassify(bayes: Bayes, session: string): Response {
    const body = `
      <h2>Classify a message</h2>
      <form method="POST" action="/classify">
        <label>
          Path to .eml file on server:
          <input type="text" name="file" placeholder="/path/to/message.eml" required style="width:400px">
        </label>
        <button class="btn-primary">Classify</button>
      </form>`;
    return this.#htmlPage("Classify", body, bayes, session);
  }

  async #doClassify(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const file = (form.get("file") as string)?.trim();
    const buckets = bayes.getBuckets(session);
    let resultHtml = "";
    if (file) {
      try {
        const result = bayes.classify(session, file);
        const colors = bayes.getBucketColors(session);
        const scoreRows = [...result.scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([b, s]) => `<tr><td>${dot(colors.get(b) ?? "black")}${esc(b)}</td><td>${(s * 100).toFixed(4)}%</td></tr>`)
          .join("");
        const bucketOptions = buckets
          .map((b) => `<option value="${esc(b)}"${b === result.bucket ? " selected" : ""}>${esc(b)}</option>`)
          .join("");
        const resultColor = colors.get(result.bucket) ?? "black";
        resultHtml = `
          <div class="result">
            <h3>Result: ${dot(resultColor)}<strong>${esc(result.bucket)}</strong>
              ${result.magnetUsed ? '<span class="badge">magnet</span>' : ""}
            </h3>
            <table>
              <thead><tr><th>Bucket</th><th>Score</th></tr></thead>
              <tbody>${scoreRows}</tbody>
            </table>
            <p style="margin-top:10px">
              <a href="/wordscores?file=${encodeURIComponent(file)}" style="font-size:.85rem">
                Show word scores →
              </a>
            </p>
            ${buckets.length > 0 ? `
            <div class="train-correction">
              <p>Was this wrong? Train as:</p>
              <form method="POST" action="/train" class="inline-form">
                <input type="hidden" name="file" value="${esc(file)}">
                <select name="bucket">${bucketOptions}</select>
                <button class="btn-primary">Train</button>
              </form>
            </div>` : ""}
          </div>`;
      } catch (e) {
        resultHtml = `<div class="error">Error: ${esc(String(e))}</div>`;
      }
    }
    const body = `
      <h2>Classify a message</h2>
      <form method="POST" action="/classify">
        <label>Path to .eml file:<br>
          <input type="text" name="file" value="${esc(file ?? "")}" style="width:400px" required>
        </label>
        <button class="btn-primary">Classify</button>
      </form>
      ${resultHtml}`;
    return this.#htmlPage("Classify", body, bayes, session);
  }

  #pageTrain(bayes: Bayes, session: string, message?: string): Response {
    const buckets = bayes.getBuckets(session);
    const bucketOptions = buckets.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
    const body = `
      <h2>Train a message</h2>
      <p>Teach the classifier the correct bucket for a message file.</p>
      ${message ? `<div class="success">${esc(message)}</div>` : ""}
      <form method="POST" action="/train">
        <div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
          <label>Path to .eml file on server:
            <input type="text" name="file" placeholder="/path/to/message.eml" required style="width:100%">
          </label>
          <label>Bucket:
            <select name="bucket" style="width:100%">${bucketOptions}</select>
          </label>
          <button class="btn-primary" style="align-self:flex-start">Train</button>
        </div>
      </form>`;
    return this.#htmlPage("Train", body, bayes, session);
  }

  async #doTrain(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const file = (form.get("file") as string)?.trim();
    const bucket = (form.get("bucket") as string)?.trim();
    if (!file || !bucket) return this.#pageTrain(bayes, session);
    try {
      const { MailParser } = await import("../classifier/MailParser.ts");
      const parsed = new MailParser().parseFile(file);
      bayes.trainMessage(session, bucket, parsed);
      return this.#pageTrain(bayes, session, `Trained "${file}" as "${bucket}".`);
    } catch (e) {
      const buckets = bayes.getBuckets(session);
      const bucketOptions = buckets.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
      const body = `
        <h2>Train a message</h2>
        <p>Teach the classifier the correct bucket for a message file.</p>
        <div class="error">Error: ${esc(String(e))}</div>
        <form method="POST" action="/train">
          <div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
            <label>Path to .eml file on server:
              <input type="text" name="file" value="${esc(file)}" required style="width:100%">
            </label>
            <label>Bucket:
              <select name="bucket" style="width:100%">${bucketOptions}</select>
            </label>
            <button class="btn-primary" style="align-self:flex-start">Train</button>
          </div>
        </form>`;
      return this.#htmlPage("Train", body, bayes, session);
    }
  }

  #pageHistory(bayes: Bayes, session: string): Response {
    const history = bayes.getHistory(session, 100);
    const buckets = bayes.getBuckets(session);
    const colors = bayes.getBucketColors(session);
    const bucketOptions = (selected: string) => buckets
      .map((b) => `<option value="${esc(b)}"${b === selected ? " selected" : ""}>${esc(b)}</option>`)
      .join("");

    const rows = history.map((h) => {
      const date = new Date(h.date * 1000).toLocaleString();
      const color = colors.get(h.bucket) ?? "black";
      const corrected = h.usedtobe
        ? `<span title="Corrected from ${esc(h.usedtobe)}" style="color:#888;font-size:.8rem"> (was ${dot(colors.get(h.usedtobe) ?? "black")}${esc(h.usedtobe)})</span>`
        : "";
      return `<tr>
        <td style="white-space:nowrap;font-size:.85rem">${date}</td>
        <td>${esc(h.subject || "(no subject)")}</td>
        <td style="font-size:.85rem">${esc(h.fromAddress)}</td>
        <td>${dot(color)}${esc(h.bucket)}${h.magnetUsed ? ' <span class="badge">magnet</span>' : ""}${corrected}</td>
        <td>
          <form method="POST" action="/history/retrain" class="inline-form" style="margin:0">
            <input type="hidden" name="id" value="${h.id}">
            <select name="bucket" style="font-size:.8rem;padding:4px 6px">${bucketOptions(h.bucket)}</select>
            <button class="btn-primary" style="padding:4px 10px;font-size:.8rem">Retrain</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const body = `
      <h2>History <span style="font-weight:400;font-size:.9rem;color:#666">(last ${history.length})</span></h2>
      ${history.length === 0
        ? '<p>No classifications yet. Use <a href="/classify">Classify</a> to classify a message.</p>'
        : `<table>
            <thead><tr>
              <th>Date</th><th>Subject</th><th>From</th><th>Classification</th><th>Correct to</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}`;
    return this.#htmlPage("History", body, bayes, session);
  }

  async #doHistoryRetrain(req: Request, bayes: Bayes, session: string): Promise<Response> {
    const form = await req.formData();
    const id = parseInt(form.get("id") as string, 10);
    const bucket = (form.get("bucket") as string)?.trim();
    if (!isNaN(id) && bucket) {
      try {
        bayes.retrainHistory(session, id, bucket);
      } catch (e) {
        this.log_(0, `Retrain error: ${e}`);
      }
    }
    return Response.redirect(new URL("/history", req.url), 303);
  }

  // -------------------------------------------------------------------------
  // Stats page
  // -------------------------------------------------------------------------

  #apiStats(bayes: Bayes, session: string): Response {
    return Response.json(bayes.getStats(session));
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

  #pageWordScores(bayes: Bayes, url: URL, session: string): Response {
    const file = url.searchParams.get("file")?.trim() ?? "";
    const buckets = bayes.getBuckets(session);
    const colors  = bayes.getBucketColors(session);

    let resultHtml = "";
    if (file) {
      try {
        const result = bayes.classifyWithWordScores(session, file);
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

    const body = `
      <h2>Word scores</h2>
      <p>Shows which words most influenced the classification of a message.</p>
      <form method="GET" action="/wordscores" class="inline-form">
        <input type="text" name="file" value="${esc(file)}" placeholder="/path/to/message.eml" style="width:400px" required>
        <button class="btn-primary">Analyse</button>
      </form>
      ${resultHtml}`;
    return this.#htmlPage("Word scores", body, bayes, session);
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
          { key: "GLOBAL_session_timeout", label: "Session timeout (seconds)", type: "number",
            hint: "How long a non-admin session stays valid (default 1800)" },
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
    const cfg = this.configuration_();

    const allKeys = [
      "classifier_unclassified_weight",
      "GLOBAL_message_cutoff",
      "GLOBAL_session_timeout",
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
  <main>${content}</main>
</body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dot(color: string): string {
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(color)};margin-right:5px;vertical-align:middle"></span>`;
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
