# POPFile — TypeScript/Deno Port

A faithful port of [POPFile](http://getpopfile.org/) from Perl to TypeScript,
running under [Deno](https://deno.land/). POPFile is a Naive Bayes email
classifier that acts as a POP3 proxy, tagging each message with its predicted
bucket (folder) via an `X-Text-Classification` header.

---

## Architecture

```
src/
├── main.ts                  Entry point — wires modules, calls loader.boot()
├── classify.ts              CLI tool — classify .eml files from the command line
├── core/
│   ├── Module.ts            Base class for all POPFile modules
│   ├── Loader.ts            Boot sequencer (run levels 0–5)
│   ├── MessageQueue.ts      Async intra-process event bus (MQ)
│   ├── Configuration.ts     Persistent key-value config (popfile.cfg)
│   ├── Logger.ts            File-based logger + hourly TICKD events
│   └── Database.ts          SQLite via @db/sqlite (schema v9)
├── classifier/
│   ├── MailParser.ts        MIME parser → word frequency map
│   └── Bayes.ts             Naive Bayes classifier + magnets + sessions
├── proxy/
│   └── POP3Proxy.ts         POP3 proxy — intercepts RETR, tags messages
├── ui/
│   └── UIServer.ts          Web UI (Deno.serve) — buckets, magnets, classify
└── tests/
    └── classifier_test.ts   Tests for MailParser
```

### Module system

Every subsystem extends `Module` (mirrors `POPFile::Module`). The `Loader`
boots them in six run levels, guaranteeing correct initialization order:

| Level | Modules |
|-------|---------|
| 0 | Configuration, MessageQueue |
| 1 | Logger |
| 2 | Database (SQLite) |
| 3 | Classifier (Bayes) |
| 4 | POP3Proxy |
| 5 | UIServer |

Modules communicate via the `MessageQueue` (event bus). Key message types:
`TICKD` (hourly, from Logger), `COMIT` (message classified), `UIREG` (UI
registration), `RELSE` (session released).

### Classifier

`Bayes.ts` implements log-probability Naive Bayes:

1. `MailParser` tokenises the message → `Map<word, frequency>`
2. Magnets are checked first (explicit string-match rules)
3. Word IDs are looked up in SQLite; the word×bucket count matrix is fetched
4. Log-probability scores are accumulated per bucket
5. The winner needs to beat second place by `log(unclassified_weight)` or the
   message is returned as `"unclassified"`
6. Scores are exponentiated and normalized to probabilities (0–1)

### Key differences from the Perl original

| Perl | TypeScript/Deno |
|------|----------------|
| `fork()` per connection | `async/await` per connection |
| DBI + SQLite | `@db/sqlite` (Deno native) |
| `IO::Select` blocking I/O | `Deno.Conn` async streams |
| `Crypt::OpenSSL::Random` | `crypto.getRandomValues()` |
| `HTML::Parser` | Custom streaming HTML stripper |
| `MIME::Base64` / `MIME::QuotedPrint` | `atob()` + custom QP decoder |
| `Encode` (charset detection) | UTF-8 first, fallback to latin-1 |
| Template Toolkit (`.thtml`) | Inline HTML generation |
| `popfile.pl` + signals | `Loader.boot()` + `Deno.addSignalListener` |

---

## Quick start

### Prerequisites

- [Deno](https://deno.land/) 2.x

### Run the full server

```bash
deno run --allow-net --allow-read --allow-write --allow-env src/main.ts
```

The POP3 proxy starts on port **110** (or `POPFILE_POP3_PORT`).  
The web UI starts on **http://127.0.0.1:8080** (or `POPFILE_UI_PORT`).

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POPFILE_USER_DIR` | `./` | Working directory for db, logs, messages |
| `POPFILE_POP3_PORT` | `110` | POP3 proxy listen port |
| `POPFILE_UI_PORT` | `8080` | Web UI listen port |

### Classify a message from the CLI

```bash
deno run --allow-net --allow-read --allow-write --allow-env \
  src/classify.ts /path/to/message.eml
```

Output:
```
'/path/to/message.eml' → 'spam'
  spam:   98.3412%
  inbox:   1.6588%
```

### Configure your email client

Set your POP3 server to `127.0.0.1` port `110` (or your chosen port).  
Use the username format: `youruser:realserver.com` or `youruser:realserver.com:995`.

Each retrieved message will have an `X-Text-Classification: <bucket>` header
added, which you can use in your mail client's filtering rules.

### Web UI

Open **http://127.0.0.1:8080** to:
- Create and delete classification buckets
- Add magnets (explicit classification rules)
- Classify individual messages interactively
- View the JSON API at `/api/buckets` and `/api/classify?file=...`

---

## Training the classifier

POPFile learns by correction. After classifying a message incorrectly, call
`trainMessage()` via the API to move the word counts to the right bucket.
The more messages you train, the more accurate classification becomes.

```typescript
const session = bayes.getAdministratorSessionKey();
const parsed = parser.parseFile("/path/to/message.eml");
bayes.trainMessage(session, "spam", parsed);
```

---

## Running tests

```bash
deno test --allow-read --allow-write --allow-net src/tests/
```

---

## What is not yet ported

The following Perl modules exist in the original codebase but are not yet
implemented in this port:

- **`Proxy::NNTP`** — NNTP (newsgroup) proxy
- **`Proxy::SMTP`** — SMTP proxy with classification tagging
- **`Proxy::POP3S`** — POP3 over SSL/TLS
- **`Services::IMAP`** — IMAP service (connects directly to IMAP server)
- **`UI::XMLRPC`** — XML-RPC API (the JSON `/api/*` routes cover the core)
- **Multi-user support** — the schema supports it but the UI only exposes
  the admin user
- **History page** — the `history` table is created but not surfaced in the UI
- **Bucket colours** — stored in `bucket_params` but not rendered in the UI
- **Japanese/Korean tokenisation** — the Perl source has special handling for
  CJK character sets; the TS port falls back to Unicode codepoint boundaries

These are all well-contained additions — each maps 1:1 to a Perl module and
can be added without touching the core infrastructure.
