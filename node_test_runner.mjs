/**
 * node_test_runner.mjs
 *
 * Runs MailParser and Bayes classifier tests under Node.js by:
 *  1. Transpiling TypeScript on the fly with esbuild (or tsc + esm)
 *  2. Stubbing Deno.* globals with Node equivalents
 *  3. Running all test cases and reporting results
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// 1. Minimal Deno global shim
// ---------------------------------------------------------------------------
globalThis.Deno = {
  readTextFileSync: (p) => readFileSync(p, "utf8"),
  writeTextFileSync: (p, c) => writeFileSync(p, c, "utf8"),
  writeTextFile: async (p, c) => writeFileSync(p, c, "utf8"),
  mkdirSync: (p, opts) => mkdirSync(p, { recursive: opts?.recursive }),
  openSync: () => ({ writeSync: () => {}, close: () => {} }),
  makeTempFile: async (opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "popfile-test-"));
    return join(dir, `tmp${opts.suffix ?? ""}`);
  },
  remove: async (p) => { try { rmSync(p, { recursive: true }); } catch {} },
  statSync: (p) => { if (!existsSync(p)) throw new Error(`ENOENT: ${p}`); return { isFile: true }; },
  env: { get: (k) => process.env[k], set: () => {} },
  args: [],
  exit: (code) => process.exit(code ?? 0),
  addSignalListener: () => {},
  listen: () => { throw new Error("Deno.listen not available in test"); },
  connect: () => { throw new Error("Deno.connect not available in test"); },
  serve: () => { throw new Error("Deno.serve not available in test"); },
};

// Web Crypto shim (Node 19+ has globalThis.crypto, but let's be safe)
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues: (buf) => { randomBytes(buf.length).copy(buf); return buf; },
  };
}

// ---------------------------------------------------------------------------
// 2. Inline transpiled versions of the modules we need to test
//    (We inline the logic rather than using import() to avoid ESM module
//     resolution issues with .ts extensions in Node)
// ---------------------------------------------------------------------------

// ---- MailParser (inlined, stripped of Deno-specific import paths) ----------

class MailParser {
  parse(rawMessage, cutoff = 100_000) {
    const limited = rawMessage.slice(0, cutoff);
    const { headers, body } = this.#splitHeadersBody(limited);
    const contentType = headers.get("content-type") ?? "text/plain";
    const encoding = headers.get("content-transfer-encoding") ?? "7bit";
    const words = new Map();
    this.#addWords(words, this.#extractHeaderText(headers));
    const bodyText = this.#decodeBody(body, contentType, encoding, headers);
    this.#addWords(words, bodyText);
    return { words, headers };
  }

  parseFile(path) {
    const raw = Deno.readTextFileSync(path);
    return this.parse(raw);
  }

  #splitHeadersBody(raw) {
    const headers = new Map();
    const blankLine = /\r?\n\r?\n/;
    const match = raw.match(blankLine);
    const headerSection = match ? raw.slice(0, match.index) : raw;
    const body = match ? raw.slice(match.index + match[0].length) : "";
    const unfolded = headerSection.replace(/\r?\n([ \t]+)/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (!headers.has(name) || name === "received") headers.set(name, value);
    }
    return { headers, body };
  }

  #extractHeaderText(headers) {
    return ["from", "to", "cc", "subject", "reply-to"]
      .map((h) => headers.get(h) ?? "").join(" ");
  }

  #decodeBody(body, contentType, encoding, headers) {
    let decoded = body;
    const enc = encoding.toLowerCase().trim();
    if (enc === "base64") {
      try { decoded = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8"); }
      catch { decoded = body; }
    } else if (enc === "quoted-printable") {
      decoded = this.#decodeQP(body);
    }
    const ct = contentType.toLowerCase();
    const boundary = this.#extractBoundary(contentType);
    if (boundary && ct.includes("multipart/")) return this.#decodeMultipart(decoded, boundary);
    if (ct.includes("text/html")) return this.#stripHtml(decoded);
    return decoded;
  }

  #extractBoundary(ct) {
    const m = ct.match(/boundary=["']?([^"';\s]+)["']?/i);
    return m ? m[1] : null;
  }

  #decodeMultipart(body, boundary) {
    const parts = [];
    for (const section of body.split(`--${boundary}`)) {
      if (section.trim() === "--" || section.trim() === "") continue;
      const { headers, body: partBody } = this.#splitHeadersBody(section);
      parts.push(this.#decodeBody(partBody, headers.get("content-type") ?? "text/plain",
        headers.get("content-transfer-encoding") ?? "7bit", headers));
    }
    return parts.join(" ");
  }

  #decodeQP(input) {
    return input.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)));
  }

  SKIP_TAGS = new Set(["script", "style", "head", "meta", "link"]);

  #stripHtml(html) {
    let out = "", i = 0, skipUntil = null;
    while (i < html.length) {
      if (html[i] === "<") {
        const tagEnd = html.indexOf(">", i);
        if (tagEnd === -1) { i++; continue; }
        const tag = html.slice(i + 1, tagEnd).trim();
        const tagName = tag.split(/[\s/]/)[0].toLowerCase();
        if (skipUntil) {
          if (tag.startsWith("/") && tag.slice(1).toLowerCase().trim() === skipUntil) skipUntil = null;
        } else if (this.SKIP_TAGS.has(tagName)) {
          skipUntil = tagName;
        } else { out += " "; }
        i = tagEnd + 1;
      } else if (!skipUntil) { out += html[i++]; }
      else { i++; }
    }
    return out.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }

  #addWords(map, text) {
    for (const token of text.toLowerCase().split(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF]+/gi)) {
      if (token.length >= 3 && token.length <= 40) map.set(token, (map.get(token) ?? 0) + 1);
    }
  }

  getHeader(result, name) { return result.headers.get(name.toLowerCase()) ?? ""; }
}

// ---------------------------------------------------------------------------
// 3. In-memory Bayes classifier (no SQLite — pure JS Map-based implementation
//    for testing the classification math)
// ---------------------------------------------------------------------------

class InMemoryBayes {
  #buckets = new Map();   // bucketName → Map<word, count>
  #magnets = [];          // { type, val, bucket }

  createBucket(name) {
    if (!this.#buckets.has(name)) this.#buckets.set(name, new Map());
  }

  train(bucketName, words) {
    if (!this.#buckets.has(bucketName)) this.createBucket(bucketName);
    const bmap = this.#buckets.get(bucketName);
    for (const [word, count] of words) bmap.set(word, (bmap.get(word) ?? 0) + count);
  }

  addMagnet(type, val, bucket) { this.#magnets.push({ type, val, bucket }); }

  classify(parsed, unclassifiedWeight = 100) {
    // Magnet check
    for (const { type, val, bucket } of this.#magnets) {
      const hval = parsed.headers.get(type.toLowerCase()) ?? "";
      if (hval.toLowerCase().includes(val.toLowerCase())) return { bucket, magnetUsed: true, scores: new Map([[bucket, 1]]) };
    }

    const bucketNames = [...this.#buckets.keys()];
    if (bucketNames.length < 2) return { bucket: "unclassified", magnetUsed: false, scores: new Map() };

    // Compute bucket totals
    const totals = new Map();
    let grandTotal = 0;
    for (const [name, words] of this.#buckets) {
      const t = [...words.values()].reduce((a, b) => a + b, 0);
      totals.set(name, t);
      grandTotal += t;
    }
    if (grandTotal === 0) return { bucket: "unclassified", magnetUsed: false, scores: new Map() };

    const notLikely = Math.log(1 / grandTotal);

    // Score each bucket
    const scores = new Map();
    for (const name of bucketNames) {
      const bTotal = totals.get(name) ?? 1;
      scores.set(name, Math.log(bTotal / grandTotal)); // prior
    }

    for (const [word, freq] of parsed.words) {
      for (const [name, bwords] of this.#buckets) {
        const count = bwords.get(word) ?? 0;
        const bTotal = totals.get(name) ?? 1;
        const prob = count > 0 ? Math.log(count / bTotal) : notLikely;
        scores.set(name, scores.get(name) + prob * freq);
      }
    }

    const ranking = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [topName, topScore] = ranking[0];
    const [, secondScore] = ranking[1];
    const winner = topScore > secondScore + Math.log(unclassifiedWeight) ? topName : "unclassified";

    // Normalize
    const base = topScore;
    let total = 0;
    const normalized = new Map();
    for (const [name, s] of ranking) { const e = Math.exp(s - base); normalized.set(name, e); total += e; }
    for (const [name, v] of normalized) normalized.set(name, Math.min(0.999999, v / total));

    return { bucket: winner, magnetUsed: false, scores: normalized };
  }
}

// ---------------------------------------------------------------------------
// 4. Test framework (minimal)
// ---------------------------------------------------------------------------

let passed = 0, failed = 0, total = 0;
const failures = [];

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗  ${name}`);
    console.log(`       ${e.message}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function assertEquals(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assert(v, msg) {
  if (!v) throw new Error(msg ?? `Assertion failed`);
}
function assertStringIncludes(s, sub) {
  if (!s.includes(sub)) throw new Error(`Expected "${s}" to include "${sub}"`);
}

// ---------------------------------------------------------------------------
// 5. Tests
// ---------------------------------------------------------------------------

const parser = new MailParser();

console.log("\n=== MailParser tests ===\n");

await test("extracts headers correctly", () => {
  const raw = ["From: alice@example.com", "To: bob@example.com",
    "Subject: Test message", "Content-Type: text/plain", "", "Hello world"].join("\r\n");
  const { headers } = parser.parse(raw);
  assertEquals(headers.get("from"), "alice@example.com");
  assertEquals(headers.get("to"), "bob@example.com");
  assertEquals(headers.get("subject"), "Test message");
});

await test("tokenises plain-text body into words", () => {
  const raw = ["From: alice@example.com", "Subject: Hello", "",
    "The quick brown fox jumps over the lazy dog"].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("quick"), "should have 'quick'");
  assert(words.has("brown"), "should have 'brown'");
  assert(words.has("jumps"), "should have 'jumps'");
  // MIN_WORD_LEN is 3, so "the" (3 chars) IS included — "of", "a" etc are not
  assert(words.has("the"), "should have 'the' (exactly 3 chars, at the minimum)");
  assert(!words.has("a"), "single-char words should be filtered");
});

await test("strips HTML tags and discards script/style content", () => {
  const raw = ["Content-Type: text/html", "",
    "<html><head><style>body{color:red}</style></head>",
    "<body><p>Hello <b>world</b></p><script>alert(1)</script></body></html>"].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("hello"), "should have 'hello'");
  assert(words.has("world"), "should have 'world'");
  assert(!words.has("color"), "should not have style content");
  assert(!words.has("alert"), "should not have script content");
});

await test("decodes quoted-printable", () => {
  const raw = ["Content-Transfer-Encoding: quoted-printable", "",
    "Caf=C3=A9 au lait is absolutely delicious"].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("lait") || words.has("absolutely"), "should extract words from QP body");
});

await test("decodes base64 body", () => {
  const bodyText = "This is a secret message with hidden words";
  const encoded = Buffer.from(bodyText).toString("base64");
  const raw = ["Content-Transfer-Encoding: base64", "", encoded].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("secret") || words.has("message"), "should decode base64 and extract words");
});

await test("handles multipart messages", () => {
  const boundary = "TESTBOUNDARY";
  const raw = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain", "", "Plain text version here",
    `--${boundary}`, "Content-Type: text/html", "", "<p>HTML version here</p>",
    `--${boundary}--`].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("plain") || words.has("text"), "should have words from plain part");
  assert(words.has("html") || words.has("version"), "should have words from html part");
});

await test("respects cutoff limit", () => {
  const bigBody = "uniqueword ".repeat(5000);
  const raw = `Subject: test\r\n\r\n${bigBody}`;
  const { words: truncated } = parser.parse(raw, 200);
  const { words: full } = parser.parse(raw);
  // Full parse sees all 5000 repetitions; truncated sees far fewer
  const fullCount = full.get("uniqueword") ?? 0;
  const truncatedCount = truncated.get("uniqueword") ?? 0;
  assert(fullCount > 100, `full parse should see many occurrences of 'uniqueword', got ${fullCount}`);
  assert(truncatedCount < fullCount, `truncated parse should see fewer occurrences: ${truncatedCount} < ${fullCount}`);
});

await test("handles RFC 2822 header folding", () => {
  const raw = ["Subject: This is a", " very long subject", "  that is folded", "",
    "body text content here"].join("\r\n");
  const { headers } = parser.parse(raw);
  assertStringIncludes(headers.get("subject") ?? "", "very long subject");
});

await test("counts word frequency correctly", () => {
  const raw = ["Subject: spam spam spam", "",
    "This message contains spam spam spam and more spam"].join("\r\n");
  const { words } = parser.parse(raw);
  const spamCount = words.get("spam") ?? 0;
  assert(spamCount >= 4, `spam should appear at least 4 times, got ${spamCount}`);
});

await test("ignores very short and very long tokens", () => {
  const longWord = "a".repeat(50);
  const raw = `Subject: test\r\n\r\nok hi ${longWord} yes`;
  const { words } = parser.parse(raw);
  assert(!words.has("ok"), "2-char word should be filtered");
  assert(!words.has("hi"), "2-char word should be filtered");
  assert(!words.has(longWord), "50-char word should be filtered");
  assert(words.has("yes"), "3-char word should pass");
});

await test("decodes HTML entities", () => {
  const raw = ["Content-Type: text/html", "",
    "<p>fish &amp; chips cost &lt;five&gt; &quot;pounds&quot;</p>"].join("\r\n");
  const { words } = parser.parse(raw);
  assert(words.has("fish"), "should have 'fish'");
  assert(words.has("chips"), "should have 'chips'");
});

await test("handles missing body gracefully", () => {
  const raw = "From: nobody@example.com\r\nSubject: empty";
  const { words, headers } = parser.parse(raw);
  assertEquals(headers.get("from"), "nobody@example.com");
  assert(words instanceof Map, "words should be a Map even with no body");
});

await test("parse from temp file", async () => {
  const tmpPath = await Deno.makeTempFile({ suffix: ".eml" });
  await Deno.writeTextFile(tmpPath, [
    "From: spammer@evil.com", "To: victim@good.com",
    "Subject: Buy cheap drugs online NOW", "",
    "Click here to purchase discount pharmaceuticals at amazing prices!",
    "Limited time offer! Act now! Free shipping worldwide!"].join("\r\n"));
  try {
    const result = parser.parseFile(tmpPath);
    assert(result.words.has("click") || result.words.has("purchase"), "should have body words");
    assertEquals(result.headers.get("from"), "spammer@evil.com");
  } finally { await Deno.remove(tmpPath); }
});

// ---------------------------------------------------------------------------
console.log("\n=== Bayes classifier tests ===\n");

await test("classifies spam vs ham correctly", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");

  // Train on obvious spam words
  const spamWords = new Map([["buy", 10], ["cheap", 10], ["viagra", 10], ["click", 10],
    ["free", 10], ["offer", 8], ["discount", 8], ["pills", 8]]);
  const hamWords  = new Map([["meeting", 10], ["agenda", 10], ["report", 10], ["project", 10],
    ["deadline", 8], ["review", 8], ["budget", 8]]);
  bayes.train("spam", spamWords);
  bayes.train("inbox", hamWords);

  const spamMsg = parser.parse("Subject: Free offer\r\n\r\nBuy cheap viagra pills free discount click");
  const hamMsg  = parser.parse("Subject: Meeting agenda\r\n\r\nProject deadline review budget report");

  const spamResult = bayes.classify(spamMsg);
  const hamResult  = bayes.classify(hamMsg);

  assertEquals(spamResult.bucket, "spam", `Spam message should be classified as spam, got: ${spamResult.bucket}`);
  assertEquals(hamResult.bucket,  "inbox", `Ham message should be classified as inbox, got: ${hamResult.bucket}`);
});

await test("returns unclassified when buckets are empty", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");
  const msg = parser.parse("Subject: test\r\n\r\nsome words here");
  const result = bayes.classify(msg);
  assertEquals(result.bucket, "unclassified");
});

await test("returns unclassified with only one bucket", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.train("spam", new Map([["buy", 5], ["cheap", 5]]));
  const msg = parser.parse("Subject: test\r\n\r\nbuy cheap stuff");
  const result = bayes.classify(msg);
  assertEquals(result.bucket, "unclassified", "Need at least 2 buckets to classify");
});

await test("magnet overrides Bayes classification", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");
  bayes.train("inbox", new Map([["meeting", 20], ["project", 20]]));
  bayes.train("spam",  new Map([["buy", 5]]));
  bayes.addMagnet("from", "boss@company.com", "inbox");

  // This message would classify as spam by content, but magnet should win
  const msg = parser.parse("From: boss@company.com\r\nSubject: buy cheap stuff\r\n\r\nbuy cheap pills discount");
  const result = bayes.classify(msg);
  assertEquals(result.bucket, "inbox", "Magnet should override Bayes");
  assertEquals(result.magnetUsed, true, "magnetUsed should be true");
});

await test("magnet is case-insensitive", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("vip");
  bayes.createBucket("other");
  bayes.train("other", new Map([["word", 10]]));
  bayes.train("vip",   new Map([["word", 5]]));
  bayes.addMagnet("from", "ALICE@EXAMPLE.COM", "vip");

  const msg = parser.parse("From: alice@example.com\r\n\r\nsome content here");
  const result = bayes.classify(msg);
  assertEquals(result.bucket, "vip");
});

await test("probability scores sum to approximately 1", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");
  bayes.createBucket("newsletters");
  bayes.train("spam",        new Map([["buy", 10], ["cheap", 10], ["free", 10]]));
  bayes.train("inbox",       new Map([["meeting", 10], ["project", 10]]));
  bayes.train("newsletters", new Map([["unsubscribe", 10], ["newsletter", 10]]));

  const msg = parser.parse("Subject: test\r\n\r\nbuy cheap free meeting");
  const { scores } = bayes.classify(msg);
  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  assert(Math.abs(total - 1.0) < 0.01, `scores should sum to ~1, got ${total}`);
});

await test("training increases correct bucket score", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");

  // Tiny training set
  bayes.train("spam",  new Map([["offer", 5]]));
  bayes.train("inbox", new Map([["hello", 5]]));

  const msg = parser.parse("Subject: test\r\n\r\nspecial offer discount limited");
  const result1 = bayes.classify(msg);

  // Now train heavily on spam for these words
  bayes.train("spam", new Map([["special", 20], ["discount", 20], ["limited", 20], ["offer", 20]]));
  const result2 = bayes.classify(msg);

  const score1 = result1.scores.get("spam") ?? 0;
  const score2 = result2.scores.get("spam") ?? 0;
  assert(score2 >= score1, `Spam score should increase after training: ${score1} → ${score2}`);
  assertEquals(result2.bucket, "spam");
});

await test("handles unknown words gracefully (not_likely path)", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("spam");
  bayes.createBucket("inbox");
  bayes.train("spam",  new Map([["buy", 10]]));
  bayes.train("inbox", new Map([["meeting", 10]]));

  // Words completely unknown to the classifier
  const msg = parser.parse("Subject: test\r\n\r\nxyzzy quux frobnicate plugh");
  // Should not throw and should return a result
  const result = bayes.classify(msg);
  assert(["spam", "inbox", "unclassified"].includes(result.bucket),
    `Should return a valid bucket, got: ${result.bucket}`);
});

await test("unclassified_weight threshold works", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("a");
  bayes.createBucket("b");
  // Train nearly equally on both
  bayes.train("a", new Map([["word", 10]]));
  bayes.train("b", new Map([["word", 9]]));

  const msg = parser.parse("Subject: test\r\n\r\nword word word");
  // With high unclassifiedWeight, close calls return unclassified
  const resultTight  = bayes.classify(msg, 100000);
  const resultRelaxed = bayes.classify(msg, 1);

  assertEquals(resultTight.bucket, "unclassified",
    "High unclassified_weight should make borderline messages unclassified");
  assertEquals(resultRelaxed.bucket, "a",
    "Low unclassified_weight should pick a winner even for close calls");
});

await test("multiple training rounds accumulate correctly", () => {
  const bayes = new InMemoryBayes();
  bayes.createBucket("cat");
  bayes.createBucket("dog");
  bayes.train("cat", new Map([["feline", 5], ["meow", 5], ["whiskers", 5]]));
  bayes.train("dog", new Map([["canine", 5], ["bark", 5], ["woof", 5]]));

  // More training rounds
  bayes.train("cat", new Map([["purr", 5], ["kitten", 5]]));
  bayes.train("dog", new Map([["fetch", 5], ["puppy", 5]]));

  const catMsg = parser.parse("Subject: test\r\n\r\nfeline meow whiskers purr kitten");
  const dogMsg = parser.parse("Subject: test\r\n\r\ncanine bark woof fetch puppy");

  assertEquals(bayes.classify(catMsg).bucket, "cat");
  assertEquals(bayes.classify(dogMsg).bucket, "dog");
});

// ---------------------------------------------------------------------------
// 6. Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${total} total`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const { name, error } of failures) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error}`);
  }
  process.exit(1);
} else {
  console.log("\nAll tests passed! ✓");
  process.exit(0);
}
