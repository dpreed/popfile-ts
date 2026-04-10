# POPFile (TypeScript/Deno)

A [Deno](https://deno.com/) port of [POPFile](http://getpopfile.org/), a Naive Bayes email classifier. POPFile sits between your mail client and your mail server, reads each message as it passes through, and adds an `X-Text-Classification` header so your client's filtering rules can sort it automatically.

## Requirements

[Deno](https://deno.com/) 2.x

```bash
curl -fsSL https://deno.land/install.sh | sh
```

## Quick start

```bash
git clone <repo-url>
cd popfile-ts
deno task start
```

Open **http://127.0.0.1:8080**. Default login: `admin` / *(blank password)*. Change it immediately via **Users → Change your password** — POPFile shows a warning banner until you do.

## Mail client setup

### POP3 (plain)

| Setting | Value |
|---------|-------|
| Server | `127.0.0.1` |
| Port | `1110` |
| Username | `youruser:mailserver.com` |

### POP3S (TLS to upstream)

| Setting | Value |
|---------|-------|
| Server | `127.0.0.1` |
| Port | `1995` |
| Encryption | **None** (POPFile handles TLS to the real server) |
| Username | `youruser:mailserver.com` or `youruser:mailserver.com:995` |

Every retrieved message gets an `X-Text-Classification: <bucket>` header. Create a filtering rule in your client on that header to move mail into folders automatically.

## Training

POPFile learns from examples. Classification improves with more training data.

### Web UI

Go to **Train** to upload individual `.eml` files, or place `.eml` files under `training/<bucketname>/` and use the bulk import button.

### CLI

```bash
# Train a directory (recursive)
deno task train spam  ~/mail/spam/
deno task train inbox ~/mail/inbox/

# Train individual files
deno task train spam msg1.eml msg2.eml

# Classify from the command line
deno task classify message.eml
```

## Optional services

### IMAP watcher

When enabled, POPFile polls a folder, classifies each message, and moves it into a subfolder named after its bucket (e.g. `spam`, `inbox`). Folders are created automatically.

Set via environment variables or the **Settings** page:

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_IMAP_SERVER` | *(disabled)* | IMAP hostname — required to enable |
| `POPFILE_IMAP_PORT` | `143` | Port (`993` for TLS) |
| `POPFILE_IMAP_TLS` | `0` | TLS: `0` or `1` |
| `POPFILE_IMAP_USERNAME` | — | Login username |
| `POPFILE_IMAP_PASSWORD` | — | Login password |
| `POPFILE_IMAP_WATCH_FOLDER` | `INBOX` | Folder to monitor |
| `POPFILE_IMAP_MOVE` | `1` | Move classified messages: `0` or `1` |
| `POPFILE_IMAP_FOLDER_PREFIX` | — | Optional prefix for bucket folder names |
| `POPFILE_IMAP_INTERVAL` | `60` | Seconds between checks |

### SMTP proxy

Classifies outgoing mail. Point your client's outgoing server at `127.0.0.1:1025`.

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_SMTP_SERVER` | *(disabled)* | Upstream hostname — required to enable |
| `POPFILE_SMTP_SERVER_PORT` | `25` | Upstream port |
| `POPFILE_SMTP_TLS` | `0` | TLS to upstream |
| `POPFILE_SMTP_PORT` | `1025` | Proxy listen port |

### NNTP proxy

Classifies Usenet articles. Point your newsreader at `127.0.0.1:1119`.

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_NNTP_SERVER` | *(disabled)* | Upstream hostname — required to enable |
| `POPFILE_NNTP_SERVER_PORT` | `119` | Upstream port |
| `POPFILE_NNTP_TLS` | `0` | TLS to upstream |
| `POPFILE_NNTP_PORT` | `1119` | Proxy listen port |

## All environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_USER_DIR` | `./` | Working directory — `popfile.db`, `logs/`, cache |
| `POPFILE_UI_PORT` | `8080` | Web UI port |
| `POPFILE_POP3_PORT` | `1110` | POP3 proxy port |
| `POPFILE_POP3S_PORT` | `1995` | POP3S proxy port |
| `POPFILE_SMTP_*` | see above | SMTP proxy (disabled unless server is set) |
| `POPFILE_NNTP_*` | see above | NNTP proxy (disabled unless server is set) |
| `POPFILE_IMAP_*` | see above | IMAP watcher (disabled unless server is set) |

All settings are also editable in the web UI under **Settings** and persisted in `popfile.cfg`.

## Data files

| Path | Description |
|------|-------------|
| `popfile.cfg` | Configuration (auto-created on first run) |
| `popfile.db` | SQLite database — words, buckets, history, users |
| `logs/` | Hourly log files |
| `training/` | Drop `.eml` files here for bulk import |

These are excluded from git (see `.gitignore`).

## Docker

```bash
# Build and start (data stored in ./data)
docker compose up -d

# Or build and run manually
docker build -t popfile-ts .
docker run -d -p 8080:8080 -p 1110:1110 -p 1995:1995 \
  -v /path/to/data:/data popfile-ts
```

Open **http://localhost:8080** after startup.

To enable HTTPS, place `cert.pem` and `key.pem` in the data directory, then enable TLS in **Settings → Security → Enable HTTPS** and restart. The session cookie gains the `Secure` flag automatically. For a self-signed certificate:

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=localhost"
```

When running behind a reverse proxy (nginx, Caddy, Traefik), enable **Trust X-Forwarded-For** in **Settings → Security** so login rate-limiting uses the real client IP.

## Multi-user mode

Each user has isolated buckets, training data, magnets, and history. Admin users manage accounts and all settings at **Users** and **Settings** in the web UI.

Passwords are hashed with PBKDF2-SHA256 (100 000 iterations). Existing plaintext passwords are migrated automatically on first login.

## Security

- CSRF protection on all forms including the login page
- Brute-force protection: 10 failed logins locks an IP for 15 minutes
- Rolling session timeout (default 30 minutes, configurable in Settings)
- Security headers on all responses: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`
- `Secure` cookie flag enabled automatically when HTTPS is on

## Magnets

Magnets are explicit rules that bypass Bayes and assign a message directly to a bucket. Useful for mailing lists, known senders, etc. Configure them under **Magnets**. Supported fields: `from`, `to`, `subject`, `cc`.

## Development

```bash
deno task test      # run all 196 tests
deno task start     # start the server
```

## Architecture

Every subsystem extends an abstract `Module` base class. A `Loader` boots all modules through ordered run levels and then drives a `service()` loop until SIGINT/SIGTERM.

| Level | Module(s) | Notes |
|-------|-----------|-------|
| 0 | `Configuration`, `MessageQueue` | Config + intra-process event bus |
| 1 | `Logger` | File logging + hourly `TICKD` events |
| 2 | `Database` | SQLite via `@db/sqlite`, WAL mode |
| 3 | `Bayes` | Classifier, sessions, user management |
| 4 | Proxies / `IMAPService` | POP3, POP3S, SMTP, NNTP, IMAP |
| 5 | `UIServer` | Web UI (`Deno.serve`) |

Classifier pipeline: MIME tokenisation → magnet check → log-probability scoring per bucket → confidence threshold (`unclassified_weight`) → `X-Text-Classification` injection.

## Origin

TypeScript/Deno rewrite of the original [POPFile](http://getpopfile.org/) by John Graham-Cumming. The Naive Bayes algorithm and SQLite schema (v9) are faithful to the original; the proxy infrastructure, web UI, and tooling are written from scratch.
