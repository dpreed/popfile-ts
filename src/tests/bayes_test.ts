/**
 * tests/bayes_test.ts — Tests for the Bayes classifier module.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/bayes_test.ts
 */

import { assertEquals, assert, assertThrows } from "jsr:@std/assert";
import { Configuration } from "../core/Configuration.ts";
import { MessageQueue } from "../core/MessageQueue.ts";
import { Logger } from "../core/Logger.ts";
import { Database } from "../core/Database.ts";
import { Bayes } from "../classifier/Bayes.ts";
import { MailParser } from "../classifier/MailParser.ts";
import { Loader } from "../core/Loader.ts";

// ---------------------------------------------------------------------------
// Test harness — boots a minimal stack against a temp DB
// ---------------------------------------------------------------------------

interface TestStack {
  bayes: Bayes;
  session: string;
  cleanup: () => void;
}

async function makeStack(): Promise<TestStack> {
  const tmpDir = await Deno.makeTempDir();
  const loader = new Loader();

  loader.register("config", new Configuration(), 0);
  loader.register("mq", new MessageQueue(), 0);
  loader.register("logger", new Logger(), 1);
  loader.register("database", new Database(), 2);
  loader.register("classifier", new Bayes(), 3);

  const modules = ["config", "mq", "logger", "database", "classifier"];

  // Initialize first so defaults are set, then override before start()
  for (const alias of modules) loader.getModule(alias).initialize();

  const config = loader.getModule("config") as Configuration;
  // Set config_user_dir so config.start() reads popfile.cfg from tmpDir
  // (which doesn't exist) rather than the real working directory
  config.parameter("config_user_dir", tmpDir);
  config.parameter("config_root_dir", tmpDir);
  config.parameter("GLOBAL_user_dir", tmpDir);
  config.parameter("logger_log_level", "0");

  for (const alias of modules) loader.getModule(alias).start();

  const bayes = loader.getModule("classifier") as Bayes;
  const session = bayes.getAdministratorSessionKey();

  const cleanup = () => {
    bayes.releaseSessionKey(session);
    for (const alias of [...modules].reverse()) {
      try { loader.getModule(alias).stop(); } catch { /* ok */ }
    }
    Deno.removeSync(tmpDir, { recursive: true });
  };

  return { bayes, session, cleanup };
}

/** Write a minimal .eml to a temp file; caller must delete it. */
async function makeEml(content: string): Promise<string> {
  const f = await Deno.makeTempFile({ suffix: ".eml" });
  await Deno.writeTextFile(f, content);
  return f;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

Deno.test("Bayes: invalid session key throws", async () => {
  const { bayes, cleanup } = await makeStack();
  try {
    assertThrows(() => bayes.getBuckets("invalid-key"), Error, "Invalid session key");
  } finally { cleanup(); }
});

Deno.test("Bayes: getAdministratorSessionKey returns a working key", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    const buckets = bayes.getBuckets(session);
    assert(Array.isArray(buckets));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Bucket management
// ---------------------------------------------------------------------------

Deno.test("Bayes: create and list buckets", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    assertEquals(bayes.getBuckets(session), []);
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    const buckets = bayes.getBuckets(session);
    assert(buckets.includes("spam"));
    assert(buckets.includes("inbox"));
    assertEquals(buckets.length, 2);
  } finally { cleanup(); }
});

Deno.test("Bayes: duplicate bucket creation is ignored", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "spam");
    assertEquals(bayes.getBuckets(session).length, 1);
  } finally { cleanup(); }
});

Deno.test("Bayes: delete bucket", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.deleteBucket(session, "spam");
    const buckets = bayes.getBuckets(session);
    assert(!buckets.includes("spam"));
    assert(buckets.includes("inbox"));
  } finally { cleanup(); }
});

Deno.test("Bayes: word count starts at zero", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    assertEquals(bayes.getBucketWordCount(session, "spam"), 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

Deno.test("Bayes: training increases word count", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  try {
    bayes.createBucket(session, "spam");
    const parsed = parser.parse("Subject: buy cheap drugs\r\n\r\nbuy cheap drugs online");
    bayes.trainMessage(session, "spam", parsed);
    assert(bayes.getBucketWordCount(session, "spam") > 0);
  } finally { cleanup(); }
});

Deno.test("Bayes: training unknown bucket throws", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  try {
    const parsed = parser.parse("Subject: test\r\n\r\nbody");
    assertThrows(
      () => bayes.trainMessage(session, "nonexistent", parsed),
      Error,
      "Unknown bucket"
    );
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test("Bayes: classifies unclassified when no buckets", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const f = await makeEml("Subject: test\r\n\r\nbody text");
  try {
    const result = bayes.classify(session, f);
    assertEquals(result.bucket, "unclassified");
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifies unclassified when only one bucket has words", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: test\r\n\r\nbody");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now"));
    // inbox has no words — classifier needs ≥2 trained buckets
    const result = bayes.classify(session, f);
    assertEquals(result.bucket, "unclassified");
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifies spam correctly after training", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();

  // Train spam
  const spamTexts = [
    "buy cheap viagra online now free shipping discount pills",
    "make money fast work from home guaranteed income cash prize",
    "congratulations winner lottery prize claim your cash reward now",
  ];
  // Train inbox
  const inboxTexts = [
    "meeting agenda for tuesday please review the attached document",
    "project update the deadline has been moved to next friday morning",
    "lunch plans are you free thursday afternoon at the usual place",
  ];

  bayes.createBucket(session, "spam");
  bayes.createBucket(session, "inbox");
  for (const t of spamTexts)
    bayes.trainMessage(session, "spam", parser.parse(`Subject: test\r\n\r\n${t}`));
  for (const t of inboxTexts)
    bayes.trainMessage(session, "inbox", parser.parse(`Subject: test\r\n\r\n${t}`));

  const spamEml = await makeEml(
    "Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount"
  );
  const inboxEml = await makeEml(
    "Subject: meeting\r\n\r\nplease review the agenda for tuesday afternoon meeting"
  );

  try {
    const spamResult = bayes.classify(session, spamEml);
    assertEquals(spamResult.bucket, "spam", "spam message should classify as spam");
    assert(spamResult.scores.has("spam"), "scores should include spam bucket");

    const inboxResult = bayes.classify(session, inboxEml);
    assertEquals(inboxResult.bucket, "inbox", "inbox message should classify as inbox");
  } finally {
    await Deno.remove(spamEml);
    await Deno.remove(inboxEml);
    cleanup();
  }
});

Deno.test("Bayes: scores sum to approximately 1", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy cheap drugs\r\n\r\nbuy cheap drugs online");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: hi\r\n\r\nmeeting agenda tuesday project review"));

    const result = bayes.classify(session, f);
    if (result.bucket !== "unclassified") {
      const total = [...result.scores.values()].reduce((s, v) => s + v, 0);
      assert(Math.abs(total - 1.0) < 0.01, `scores should sum to ~1, got ${total}`);
    }
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyMessage matches classify", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy drugs\r\n\r\nbuy cheap drugs online");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: hi\r\n\r\nmeeting agenda tuesday review"));

    const parsed = parser.parseFile(f);
    const r1 = bayes.classify(session, f);
    const r2 = bayes.classifyMessage(session, parsed);
    assertEquals(r1.bucket, r2.bucket);
  } finally { await Deno.remove(f); cleanup(); }
});

// ---------------------------------------------------------------------------
// Magnets
// ---------------------------------------------------------------------------

Deno.test("Bayes: magnet overrides Bayes classification", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml(
    "From: boss@company.com\r\nSubject: quarterly report\r\n\r\nbuy cheap drugs"
  );
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    // Train so Bayes would say spam
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: hi\r\n\r\nmeeting agenda tuesday review"));
    // Magnet: anything from boss@company.com → inbox
    bayes.addMagnet(session, "inbox", "from", "boss@company.com");

    const result = bayes.classify(session, f);
    assertEquals(result.bucket, "inbox");
    assert(result.magnetUsed, "magnetUsed should be true");
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: delete magnet restores Bayes classification", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml(
    "From: boss@company.com\r\nSubject: buy drugs\r\n\r\nbuy cheap drugs online"
  );
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: hi\r\n\r\nmeeting agenda tuesday review"));

    bayes.addMagnet(session, "inbox", "from", "boss@company.com");
    const magnets = bayes.getMagnets(session);
    assertEquals(magnets.length, 1);
    assertEquals(magnets[0].bucketName, "inbox");

    bayes.deleteMagnet(session, magnets[0].id);
    assertEquals(bayes.getMagnets(session).length, 0);

    // Without magnet, Bayes should win (spam-like body)
    const result = bayes.classify(session, f);
    assert(!result.magnetUsed);
  } finally { await Deno.remove(f); cleanup(); }
});

// ---------------------------------------------------------------------------
// Bucket colours
// ---------------------------------------------------------------------------

Deno.test("Bayes: default bucket colour is black", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    const colors = bayes.getBucketColors(session);
    assertEquals(colors.get("spam"), "black");
  } finally { cleanup(); }
});

Deno.test("Bayes: setBucketColor persists", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.setBucketColor(session, "spam", "#ff0000");
    assertEquals(bayes.getBucketColors(session).get("spam"), "#ff0000");
    // Update again
    bayes.setBucketColor(session, "spam", "#00ff00");
    assertEquals(bayes.getBucketColors(session).get("spam"), "#00ff00");
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

Deno.test("Bayes: classify writes history", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy drugs\r\n\r\nbuy cheap drugs online");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: spam\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: hi\r\n\r\nmeeting agenda tuesday review"));

    assertEquals(bayes.getHistory(session).length, 0);
    bayes.classify(session, f);
    assertEquals(bayes.getHistory(session).length, 1);

    const entry = bayes.getHistory(session)[0];
    assertEquals(entry.subject, "buy drugs");
    assertEquals(entry.filename, f);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: retrainHistory corrects the bucket", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  // Use a clearly spam-like message and enough training to ensure it
  // classifies as "spam" (not "unclassified") so usedtobe is non-null.
  const f = await makeEml(
    "Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount"
  );
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
      "congratulations winner lottery prize claim your cash reward now",
    ]) bayes.trainMessage(session, "spam", parser.parse(`Subject: test\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
      "lunch plans are you free thursday afternoon at the usual place",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: test\r\n\r\n${t}`));

    bayes.classify(session, f);
    const [entry] = bayes.getHistory(session);
    assertEquals(entry.bucket, "spam"); // confirm it landed in spam

    bayes.retrainHistory(session, entry.id, "inbox");

    const [updated] = bayes.getHistory(session);
    assertEquals(updated.bucket, "inbox");
    assertEquals(updated.usedtobe, "spam"); // old bucket recorded
  } finally { await Deno.remove(f); cleanup(); }
});
