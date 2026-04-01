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
import { Bayes } from "../classifier/Bayes.ts";

export class UIServer extends Module {
  #server: Deno.HttpServer | null = null;
  #session = "";

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

    const bayes = this.getModule_<Bayes>("classifier");
    this.#session = bayes.getAdministratorSessionKey();

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
    super.stop();
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const bayes = this.getModule_<Bayes>("classifier");

    try {
      // API routes (JSON)
      if (path === "/api/buckets") return this.#apiBuckets(bayes);
      if (path === "/api/classify") return await this.#apiClassify(url, bayes);
      if (path === "/api/train" && req.method === "POST") return await this.#apiTrain(req, bayes);

      // HTML routes
      if (path === "/" || path === "") return Response.redirect(new URL("/buckets", req.url));
      if (path === "/buckets" && req.method === "GET") return this.#pageBuckets(bayes);
      if (path === "/buckets/create" && req.method === "POST") return await this.#createBucket(req, bayes);
      if (path === "/buckets/delete" && req.method === "POST") return await this.#deleteBucket(req, bayes);
      if (path === "/magnets" && req.method === "GET") return this.#pageMagnets(bayes);
      if (path === "/magnets/add" && req.method === "POST") return await this.#addMagnet(req, bayes);
      if (path === "/magnets/delete" && req.method === "POST") return await this.#deleteMagnet(req, bayes);
      if (path === "/classify" && req.method === "GET") return this.#pageClassify(bayes);
      if (path === "/classify" && req.method === "POST") return await this.#doClassify(req, bayes);
      if (path === "/train" && req.method === "GET") return this.#pageTrain(bayes);
      if (path === "/train" && req.method === "POST") return await this.#doTrain(req, bayes);
      if (path === "/history" && req.method === "GET") return this.#pageHistory(bayes);
      if (path === "/history/retrain" && req.method === "POST") return await this.#doHistoryRetrain(req, bayes);

      return this.#html404();
    } catch (e) {
      this.log_(0, `UI error: ${e}`);
      return new Response(`Internal error: ${e}`, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // API handlers
  // -------------------------------------------------------------------------

  #apiBuckets(bayes: Bayes): Response {
    const buckets = bayes.getBuckets(this.#session);
    const data = buckets.map((name) => ({
      name,
      wordCount: bayes.getBucketWordCount(this.#session, name),
    }));
    return Response.json(data);
  }

  async #apiTrain(req: Request, bayes: Bayes): Promise<Response> {
    const { file, bucket } = await req.json();
    if (!file || !bucket) return Response.json({ error: "Missing file or bucket" }, { status: 400 });
    try {
      const { MailParser } = await import("../classifier/MailParser.ts");
      const parsed = new MailParser().parseFile(file);
      bayes.trainMessage(this.#session, bucket, parsed);
      return Response.json({ ok: true, file, bucket });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
  }

  async #apiClassify(url: URL, bayes: Bayes): Promise<Response> {
    const file = url.searchParams.get("file");
    if (!file) return Response.json({ error: "Missing ?file=" }, { status: 400 });
    try {
      const result = bayes.classify(this.#session, file);
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

  #pageBuckets(bayes: Bayes): Response {
    const buckets = bayes.getBuckets(this.#session);
    const rows = buckets.map((name) => {
      const wc = bayes.getBucketWordCount(this.#session, name);
      return `<tr>
        <td>${esc(name)}</td>
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
    return this.#htmlPage("Buckets", body);
  }

  async #createBucket(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const name = (form.get("name") as string | null)?.trim();
    if (name) bayes.createBucket(this.#session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  async #deleteBucket(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const name = form.get("name") as string | null;
    if (name) bayes.deleteBucket(this.#session, name);
    return Response.redirect(new URL("/buckets", req.url), 303);
  }

  #pageMagnets(bayes: Bayes): Response {
    const magnets = bayes.getMagnets(this.#session);
    const buckets = bayes.getBuckets(this.#session);
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
    return this.#htmlPage("Magnets", body);
  }

  async #addMagnet(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const type = form.get("type") as string;
    const value = (form.get("value") as string)?.trim();
    const bucket = form.get("bucket") as string;
    if (type && value && bucket) bayes.addMagnet(this.#session, bucket, type, value);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  async #deleteMagnet(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const id = parseInt(form.get("id") as string, 10);
    if (!isNaN(id)) bayes.deleteMagnet(this.#session, id);
    return Response.redirect(new URL("/magnets", req.url), 303);
  }

  #pageClassify(bayes: Bayes): Response {
    const body = `
      <h2>Classify a message</h2>
      <form method="POST" action="/classify">
        <label>
          Path to .eml file on server:
          <input type="text" name="file" placeholder="/path/to/message.eml" required style="width:400px">
        </label>
        <button class="btn-primary">Classify</button>
      </form>`;
    return this.#htmlPage("Classify", body);
  }

  async #doClassify(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const file = (form.get("file") as string)?.trim();
    const buckets = bayes.getBuckets(this.#session);
    let resultHtml = "";
    if (file) {
      try {
        const result = bayes.classify(this.#session, file);
        const scoreRows = [...result.scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([b, s]) => `<tr><td>${esc(b)}</td><td>${(s * 100).toFixed(4)}%</td></tr>`)
          .join("");
        const bucketOptions = buckets
          .map((b) => `<option value="${esc(b)}"${b === result.bucket ? " selected" : ""}>${esc(b)}</option>`)
          .join("");
        resultHtml = `
          <div class="result">
            <h3>Result: <strong>${esc(result.bucket)}</strong>
              ${result.magnetUsed ? '<span class="badge">magnet</span>' : ""}
            </h3>
            <table>
              <thead><tr><th>Bucket</th><th>Score</th></tr></thead>
              <tbody>${scoreRows}</tbody>
            </table>
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
    return this.#htmlPage("Classify", body);
  }

  #pageTrain(bayes: Bayes, message?: string): Response {
    const buckets = bayes.getBuckets(this.#session);
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
    return this.#htmlPage("Train", body);
  }

  async #doTrain(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const file = (form.get("file") as string)?.trim();
    const bucket = (form.get("bucket") as string)?.trim();
    if (!file || !bucket) return this.#pageTrain(bayes);
    try {
      const { MailParser } = await import("../classifier/MailParser.ts");
      const parsed = new MailParser().parseFile(file);
      bayes.trainMessage(this.#session, bucket, parsed);
      return this.#pageTrain(bayes, `Trained "${file}" as "${bucket}".`);
    } catch (e) {
      const buckets = bayes.getBuckets(this.#session);
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
      return this.#htmlPage("Train", body);
    }
  }

  #pageHistory(bayes: Bayes): Response {
    const history = bayes.getHistory(this.#session, 100);
    const buckets = bayes.getBuckets(this.#session);
    const bucketOptions = (selected: string) => buckets
      .map((b) => `<option value="${esc(b)}"${b === selected ? " selected" : ""}>${esc(b)}</option>`)
      .join("");

    const rows = history.map((h) => {
      const date = new Date(h.date * 1000).toLocaleString();
      const corrected = h.usedtobe
        ? `<span title="Corrected from ${esc(h.usedtobe)}" style="color:#888;font-size:.8rem"> (was ${esc(h.usedtobe)})</span>`
        : "";
      return `<tr>
        <td style="white-space:nowrap;font-size:.85rem">${date}</td>
        <td>${esc(h.subject || "(no subject)")}</td>
        <td style="font-size:.85rem">${esc(h.fromAddress)}</td>
        <td>${esc(h.bucket)}${h.magnetUsed ? ' <span class="badge">magnet</span>' : ""}${corrected}</td>
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
    return this.#htmlPage("History", body);
  }

  async #doHistoryRetrain(req: Request, bayes: Bayes): Promise<Response> {
    const form = await req.formData();
    const id = parseInt(form.get("id") as string, 10);
    const bucket = (form.get("bucket") as string)?.trim();
    if (!isNaN(id) && bucket) {
      try {
        bayes.retrainHistory(this.#session, id, bucket);
      } catch (e) {
        this.log_(0, `Retrain error: ${e}`);
      }
    }
    return Response.redirect(new URL("/history", req.url), 303);
  }

  #html404(): Response {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // -------------------------------------------------------------------------
  // HTML template
  // -------------------------------------------------------------------------

  #htmlPage(title: string, content: string): Response {
    const navItems = [
      ["Buckets", "/buckets"],
      ["Magnets", "/magnets"],
      ["Classify", "/classify"],
      ["Train", "/train"],
      ["History", "/history"],
    ].map(([label, href]) => `<a href="${href}">${label}</a>`).join(" | ");

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
