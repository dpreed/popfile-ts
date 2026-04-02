# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the full server
deno task start

# Classify a single .eml file from the CLI
deno task classify /path/to/message.eml

# Bulk-train .eml files into a bucket (files or directories, recursive)
deno task train <bucket> <file-or-dir> [file-or-dir ...]

# Run all tests
deno task test

# Run a single test file
deno test --allow-net --allow-read --allow-write --allow-env src/tests/classifier_test.ts
```

## Architecture

This is a TypeScript/Deno port of [POPFile](http://getpopfile.org/), a Naive Bayes email classifier that acts as a POP3 proxy. It inserts an `X-Text-Classification` header into each retrieved message.

### Module system

Every subsystem extends the abstract `Module` base class (`src/core/Module.ts`). The `Loader` (`src/core/Loader.ts`) boots all registered modules through six run levels in strict order, then runs a main `service()` loop until shutdown (SIGINT/SIGTERM).

Lifecycle order per module: `initialize()` → `start()` → repeated `service()` → `stop()`.

Run levels and module dependencies:

| Level | Module(s) | Notes |
|-------|-----------|-------|
| 0 | `Configuration`, `MessageQueue` | Must come first |
| 1 | `Logger` | Emits hourly `TICKD` events via MQ |
| 2 | `Database` | SQLite via `@db/sqlite`, schema v9 |
| 3 | `Bayes` | Depends on Database |
| 4 | `POP3Proxy` | Depends on Bayes |
| 5 | `UIServer` | Depends on Bayes |

Modules communicate via `MessageQueue` (intra-process event bus). Key message types: `TICKD` (hourly tick), `COMIT` (message classified), `UIREG` (UI registration), `RELSE` (session released).

Modules access siblings through typed protected methods: `mq_()`, `configuration_()`, `logger_()`, `database_()`, `db_()`. Config values are namespaced by module: `{module}_{name}` (e.g. `pop3_port`).

### Classifier pipeline

1. `MailParser` tokenises a raw MIME message → `Map<word, frequency>`. Handles multipart, HTML stripping, quoted-printable/base64 decoding, header folding, and a configurable body cutoff.
2. `Bayes` checks magnets first (explicit string-match rules that short-circuit classification).
3. Word IDs are looked up in SQLite; the word×bucket count matrix drives log-probability scoring.
4. Winner must beat second place by `log(unclassified_weight)` or the result is `"unclassified"`.
5. Scores are exponentiated and normalised to probabilities.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_USER_DIR` | `./` | Working directory for db, logs, messages |
| `POPFILE_POP3_PORT` | `1110` | POP3 proxy listen port |
| `POPFILE_UI_PORT` | `8080` | Web UI listen port |

### IMAP service

Set these environment variables (or config keys) to enable:

| Variable | Config key | Description |
|----------|-----------|-------------|
| `POPFILE_IMAP_SERVER` | `imap_server` | IMAP hostname (required to enable) |
| `POPFILE_IMAP_PORT` | `imap_port` | Port (default 143; 993 for TLS) |
| `POPFILE_IMAP_TLS` | `imap_tls` | Use TLS: 0 or 1 (default 0) |
| `POPFILE_IMAP_USERNAME` | `imap_username` | Login username |
| `POPFILE_IMAP_PASSWORD` | `imap_password` | Login password |
| `POPFILE_IMAP_WATCH_FOLDER` | `imap_watch_folder` | Folder to monitor (default INBOX) |
| `POPFILE_IMAP_MOVE` | `imap_move` | Move to bucket folders: 0 or 1 (default 1) |
| `POPFILE_IMAP_FOLDER_PREFIX` | `imap_folder_prefix` | Prefix for bucket folder names |
| `POPFILE_IMAP_INTERVAL` | `imap_interval` | Seconds between checks (default 60) |

When `imap_move=1`, each classified message is copied to a folder named after its bucket (e.g. `spam`, `inbox`), then deleted from the watch folder. Folders are created automatically.

### POP3S proxy

Listens on port **1995** (or `POPFILE_POP3S_PORT`). Connects to the upstream server with TLS. Configure your mail client to connect to `127.0.0.1:1995` with **no encryption** (POPFile handles TLS to the real server).

Username format: `youruser:realserver.com` or `youruser:realserver.com:995`

If no port is given, defaults to upstream port **995**. TLS is also auto-enabled when the upstream port is 995.

### Not yet ported

`Proxy::NNTP`, `Proxy::SMTP`, `Proxy::POP3S`, `Services::IMAP`, `UI::XMLRPC`, multi-user UI, history page, bucket colours, CJK tokenisation. Each maps 1:1 to a Perl module and can be added without touching core infrastructure.
