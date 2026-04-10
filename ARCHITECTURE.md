# Architecture

POPFile is a Naive Bayes email classifier that operates as a transparent proxy. This document describes the TypeScript/Deno implementation.

## Source layout

```
src/
  main.ts               Entry point — registers modules and starts the Loader
  classify.ts           CLI classify command
  train.ts              CLI train command
  core/
    Module.ts           Abstract base class for every subsystem
    Loader.ts           Boot sequencer and service loop
    Configuration.ts    INI-file config store (popfile.cfg)
    MessageQueue.ts     Intra-process event bus
    Logger.ts           File logging + hourly TICKD events
    Database.ts         SQLite connection and schema management
  classifier/
    MailParser.ts       MIME tokeniser → word-frequency map
    Bayes.ts            Naive Bayes classifier, sessions, user management
  proxy/
    POP3Proxy.ts        POP3 proxy (plain)
    POP3SProxy.ts       POP3 proxy (TLS to upstream)
    SMTPProxy.ts        SMTP proxy
    NNTPProxy.ts        NNTP proxy
  services/
    IMAPService.ts      IMAP watcher (classify-in-place, no proxy)
  ui/
    UIServer.ts         Web UI (Deno.serve)
  tests/                One test file per source module
```

## Module system

Every subsystem extends `Module` (`src/core/Module.ts`). The `Loader` (`src/core/Loader.ts`) owns a shared `ModuleRegistry` (a `Map<string, Module>`), boots all registered modules through six run levels in strict order, then drives a `service()` loop until SIGINT/SIGTERM.

### Lifecycle

```
initialize()  — register config defaults; no I/O
start()       — open sockets, load files, subscribe to MQ messages
service()     — called every ~10 ms; return false to request shutdown
stop()        — close sockets, flush state
```

Modules communicate via `MessageQueue` (intra-process event bus). A module posts a message with `mqPost_(type, ...args)` and registers to receive messages with `mqRegister_(type, this)`, overriding `deliver(type, ...args)` to handle them.

Key message types:

| Type | Sender | Meaning |
|------|--------|---------|
| `TICKD` | `Logger` | Hourly tick — used for housekeeping sweeps |
| `COMIT` | proxies | Message classified and committed to history |
| `UIREG` | `UIServer` | UI route registered |
| `RELSE` | `UIServer` | Browser session released |

Modules access siblings through typed protected accessors: `mq_()`, `configuration_()`, `logger_()`, `database_()`, `db_()`. Config values are namespaced by module name: `{module}_{key}` (e.g. `pop3_port`, `classifier_unclassified_weight`).

### Run levels

| Level | Module(s) | Reason for ordering |
|-------|-----------|---------------------|
| 0 | `Configuration`, `MessageQueue` | Everything else depends on config and MQ |
| 1 | `Logger` | Writes to a path from config; emits TICKD |
| 2 | `Database` | Opens SQLite; needed by Bayes |
| 3 | `Bayes` | Loads word matrix from DB; needed by proxies and UI |
| 4 | `POP3Proxy`, `POP3SProxy`, `SMTPProxy`, `NNTPProxy`, `IMAPService` | All depend on Bayes |
| 5 | `UIServer` | Depends on Bayes; starts last so all other modules are ready |

## Configuration

`Configuration` stores key-value pairs in memory and persists them to `popfile.cfg` (INI format) on `stop()` and on hourly `TICKD`. Values are loaded from the file on `start()`. Every module registers its own defaults in `initialize()` before `start()` loads the file, so file values override defaults but absent keys fall back cleanly.

Keys are namespaced: `{module}_{name}`. The special namespace `GLOBAL_` holds cross-module settings (`session_timeout`, `message_cutoff`, etc.). Environment variables of the form `POPFILE_{KEY}` (uppercased, `_` separator) are read by `main.ts` and injected as config parameters before startup.

## Database

`Database` owns the single `@db/sqlite` connection, opened in WAL mode for safe concurrent reads during long writes. The schema (version 9, faithful to the original Perl POPFile) is applied on first run. All other modules obtain the connection handle via `db_()` and issue queries directly — there is no ORM layer.

Key tables:

| Table | Contents |
|-------|----------|
| `users` | User accounts (id, name, hashed password) |
| `buckets` | Per-user bucket definitions |
| `bucket_params` / `bucket_template` | Per-bucket settings (e.g. colour) |
| `words` | Global word dictionary (id, word) |
| `matrix` | Word × bucket count (wordid, bucketid, times) |
| `history` | Per-message classification log |
| `magnets` / `magnet_types` | Explicit override rules |

## Classifier

### Tokenisation (`MailParser`)

`MailParser.parse(rawMessage)` returns `{ words: Map<string, number>, headers: Map<string, string> }`.

Steps:
1. Split headers from body at the first blank line.
2. Decode header folding and extract `From`, `To`, `Subject`, `Cc`, `Content-Type`, `Content-Transfer-Encoding`.
3. Recursively unwrap MIME multipart messages using boundary markers.
4. Decode `quoted-printable` and `base64` transfer encodings.
5. For `text/html` parts: strip tags, discard `<script>`, `<style>`, and `<head>` content entirely.
6. Normalise to lowercase, split on non-alphanumeric boundaries, discard tokens shorter than 3 or longer than 40 characters.
7. For CJK text (no word spaces): extract overlapping character bigrams instead.
8. Stop after `message_cutoff` bytes of body to bound classification time on huge messages.

### Bayes scoring (`Bayes`)

Given a parsed message, `classifyParsed(userId, parsed)` runs:

1. **Magnet check** — iterate the user's magnet rules. If any rule matches a header field, return that bucket immediately (no Bayes scoring).
2. **Log-prior initialisation** — for each bucket `b`: `score[b] = log(wordCount[b] / totalWords)`.
3. **Word scoring** — for each word in the message, look up its per-bucket counts in the `matrix` table, compute `log(count / bucketTotal)` (with Laplace smoothing via `notLikely`), and add to `score[b]` weighted by word frequency.
4. **Winner selection** — the bucket with the highest log-probability wins. If the winner's score does not exceed the runner-up by at least `log(unclassified_weight)`, the result is `"unclassified"`.
5. **Probability normalisation** — exponentiate and normalise scores to produce a `Map<bucket, probability>` for display.

`#updateConstants()` pre-computes per-bucket totals and log-priors into in-memory caches (`#bucketWordCounts`, `#bucketsCache`) on every training mutation, so classification reads require at most two DB round-trips (word lookups only).

### Sessions

`Bayes` manages session keys that gate all classifier API calls. A session is a random token mapped to `{ userId, expires }`. Sessions expire after `session_timeout` seconds; `touchSession()` extends the expiry on every authenticated request (rolling window). `UIServer` registers for `TICKD` and sweeps stale browser-session and rate-limiter entries hourly.

## Proxies

All four proxies follow the same pattern:

1. `Deno.listen()` on a configured local port.
2. For each accepted connection, open a TCP (or TLS) connection to the upstream server.
3. Relay bytes in both directions, intercepting specific protocol commands to classify messages and inject `X-Text-Classification: <bucket>` into the message headers.
4. Write a history entry via `Bayes` and post `COMIT` to the MQ.

| Proxy | Intercept point | Header target |
|-------|----------------|---------------|
| `POP3Proxy` | `RETR` / `TOP` response | Injected after first blank line |
| `POP3SProxy` | Same as POP3; upstream connection uses TLS | — |
| `SMTPProxy` | `DATA` command body | Injected after RFC 2822 headers |
| `NNTPProxy` | `ARTICLE` / `HEAD` response | Injected into article headers |

POP3 username encodes the upstream server: `user:realserver.com` or `user:realserver.com:995`. The proxy parses this on `USER`, connects to the real server, and forwards a plain `USER user` command.

## IMAP service

`IMAPService` is not a proxy — it connects directly to an IMAP server and polls a watch folder. On each interval:

1. `SELECT` the watch folder; fetch unseen messages.
2. Classify each message with `Bayes`.
3. If `imap_move=1`: `COPY` to the bucket's subfolder (creating it with `CREATE` if needed), then `STORE +FLAGS \Deleted` and `EXPUNGE`.
4. If `imap_move=0`: set `\Seen` and leave in place.

## Web UI

`UIServer` serves a plain HTML/CSS interface via `Deno.serve`. There is no JavaScript framework — all pages are server-rendered strings.

### Authentication

- Login form issues a single-use pre-auth CSRF token (15-minute TTL) to prevent login CSRF.
- On successful login, `Bayes.loginUser()` verifies the password (PBKDF2-SHA256, 100 000 iterations) and returns a session key. `UIServer` maps a random browser cookie token to that session key.
- Every authenticated response embeds a per-session CSRF token in a `<meta name="csrf-token">` tag. All mutation routes verify `_csrf` in the form body before acting.
- Brute-force protection: 10 failed logins per IP triggers a 15-minute lockout. Partial failure counts and expired lockouts are swept hourly on `TICKD`.
- Rolling session timeout: `touchSession()` is called on every authenticated request.

### Routes

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/metrics` | Prometheus text — unauthenticated |
| `GET/POST` | `/login`, `POST /logout` | Auth — no session required |
| `GET` | `/stats`, `/history`, `/buckets`, `/magnets`, `/classify`, `/train`, `/wordscores`, `/settings`, `/users` | Authenticated HTML pages |
| `POST` | `/buckets/create`, `/buckets/delete`, `/buckets/color` | Bucket mutations |
| `POST` | `/magnets/add`, `/magnets/delete` | Magnet mutations |
| `POST` | `/history/retrain` | Reclassify a history entry |
| `GET` | `/history/export` | CSV download |
| `POST` | `/train`, `/train/import` | Training |
| `POST` | `/classify` | File upload classify |
| `GET` | `/api/buckets`, `/api/stats` | JSON |

Settings (`/settings`) and user management (`/users`) are admin-only.

## Security

| Control | Implementation |
|---------|---------------|
| CSRF | Synchronizer token on login form; per-session token on all authenticated mutations |
| Brute force | Per-IP counter; 10 failures → 15-minute lockout |
| Password storage | PBKDF2-SHA256, 100 000 iterations |
| Session fixation | New session key issued on every login |
| Clickjacking | `X-Frame-Options: DENY` on all HTML responses |
| MIME sniffing | `X-Content-Type-Options: nosniff` |
| CSP | `Content-Security-Policy: default-src 'self'` |
| TLS | Optional; `Deno.serve` cert/key options; `Secure` cookie flag added automatically |
| Reverse proxy | Opt-in `X-Forwarded-For` trust via `ui_trusted_proxy` setting |
| CSS injection | Bucket colours stored and rendered as validated `#rrggbb` hex only |
| File path injection | Classify/train operate on uploaded cache files (UUID-named); no server-side path parameters |
