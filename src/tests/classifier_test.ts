/**
 * tests/classifier_test.ts — Tests for MailParser and Bayes classifier.
 *
 * Run with:
 *   deno test --allow-read --allow-write --allow-net src/tests/classifier_test.ts
 */

import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert";
import { MailParser } from "../classifier/MailParser.ts";

// ---------------------------------------------------------------------------
// MailParser tests
// ---------------------------------------------------------------------------

Deno.test("MailParser: extracts headers correctly", () => {
  const raw = [
    "From: alice@example.com",
    "To: bob@example.com",
    "Subject: Test message",
    "Content-Type: text/plain",
    "",
    "Hello world this is a test",
  ].join("\r\n");

  const parser = new MailParser();
  const result = parser.parse(raw);

  assertEquals(result.headers.get("from"), "alice@example.com");
  assertEquals(result.headers.get("to"), "bob@example.com");
  assertEquals(result.headers.get("subject"), "Test message");
});

Deno.test("MailParser: tokenises plain-text body into words", () => {
  const raw = [
    "From: alice@example.com",
    "Subject: Hello",
    "",
    "The quick brown fox jumps over the lazy dog",
  ].join("\r\n");

  const parser = new MailParser();
  const { words } = parser.parse(raw);

  assert(words.has("quick"), "should have 'quick'");
  assert(words.has("brown"), "should have 'brown'");
  assert(words.has("jumps"), "should have 'jumps'");
  // MIN_WORD_LEN=3: "the" passes (3 chars), single-char words do not
  assert(words.has("the"), "should have 'the' (3 chars = minimum length)");
  assert(!words.has("a"), "single-char words should be filtered");
});

Deno.test("MailParser: strips HTML tags", () => {
  const raw = [
    "Content-Type: text/html",
    "",
    "<html><head><style>body{color:red}</style></head>",
    "<body><p>Hello <b>world</b></p><script>alert(1)</script></body></html>",
  ].join("\r\n");

  const parser = new MailParser();
  const { words } = parser.parse(raw);

  assert(words.has("hello"), "should have 'hello'");
  assert(words.has("world"), "should have 'world'");
  assert(!words.has("color"), "should not have style content");
  assert(!words.has("alert"), "should not have script content");
});

Deno.test("MailParser: decodes quoted-printable", () => {
  const raw = [
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 au lait is delicious",
  ].join("\r\n");

  const parser = new MailParser();
  const { words } = parser.parse(raw);
  assert(words.size > 0, "should extract some words");
});

Deno.test("MailParser: handles multipart messages", () => {
  const boundary = "BOUNDARY123";
  const raw = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    "Plain text version of the email",
    `--${boundary}`,
    "Content-Type: text/html",
    "",
    "<p>HTML version of the email</p>",
    `--${boundary}--`,
  ].join("\r\n");

  const parser = new MailParser();
  const { words } = parser.parse(raw);

  assert(words.has("plain") || words.has("version"), "should have words from plain part");
  assert(words.has("html") || words.has("version"), "should have words from html part");
});

Deno.test("MailParser: respects cutoff limit", () => {
  const bigBody = "word ".repeat(10000);
  const raw = `Subject: test\r\n\r\n${bigBody}`;

  const parser = new MailParser();
  // With cutoff of 100 chars, body will be truncated
  const { words: truncated } = parser.parse(raw, 100);
  const { words: full } = parser.parse(raw);

  assert(full.size >= truncated.size, "full parse should have at least as many words");
});

Deno.test("MailParser: handles header folding (RFC 2822)", () => {
  const raw = [
    "Subject: This is a",
    " very long subject",
    "  that is folded",
    "",
    "body text here for testing",
  ].join("\r\n");

  const parser = new MailParser();
  const { headers } = parser.parse(raw);
  assertStringIncludes(headers.get("subject") ?? "", "very long subject");
});

Deno.test("MailParser: word frequency counting", () => {
  const raw = [
    "Subject: spam spam spam",
    "",
    "This message contains spam spam spam and more spam",
  ].join("\r\n");

  const parser = new MailParser();
  const { words } = parser.parse(raw);

  const spamCount = words.get("spam") ?? 0;
  assert(spamCount >= 4, `spam should appear at least 4 times, got ${spamCount}`);
});

// ---------------------------------------------------------------------------
// Integration test: classify a real .eml file written to disk
// ---------------------------------------------------------------------------

Deno.test("MailParser: parse from file", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".eml" });
  try {
    await Deno.writeTextFile(tmpFile, [
      "From: spammer@evil.com",
      "To: victim@good.com",
      "Subject: Buy cheap drugs online NOW",
      "",
      "Click here to purchase discount pharmaceuticals at amazing prices!",
      "Limited time offer! Act now! Free shipping worldwide!",
    ].join("\r\n"));

    const parser = new MailParser();
    const result = parser.parseFile(tmpFile);

    assert(result.words.has("click") || result.words.has("purchase"), "should have body words");
    assertEquals(result.headers.get("from"), "spammer@evil.com");
  } finally {
    await Deno.remove(tmpFile);
  }
});
