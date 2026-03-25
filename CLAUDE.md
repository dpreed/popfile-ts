# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the full server
deno task start

# Classify a single .eml file from the CLI
deno task classify /path/to/message.eml

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

### Not yet ported

`Proxy::NNTP`, `Proxy::SMTP`, `Proxy::POP3S`, `Services::IMAP`, `UI::XMLRPC`, multi-user UI, history page, bucket colours, CJK tokenisation. Each maps 1:1 to a Perl module and can be added without touching core infrastructure.
