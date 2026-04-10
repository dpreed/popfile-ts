/**
 * tests/bayes_test.ts — Tests for the Bayes classifier module.
 *
 * Run with:
 *   deno test --allow-net --allow-read --allow-write --allow-env --allow-ffi \
 *     src/tests/bayes_test.ts
 */

import { assertEquals, assert, assertThrows, assertAlmostEquals } from "jsr:@std/assert";
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

// ---------------------------------------------------------------------------
// History pagination and filtering
// ---------------------------------------------------------------------------

Deno.test("Bayes: getHistoryCount returns 0 with no history", async () => {
  const { bayes, session, cleanup } = await makeStack();
  assertEquals(bayes.getHistoryCount(session), 0);
  cleanup();
});

Deno.test("Bayes: getHistoryCount increments after classify", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: test\r\n\r\nhello world");
  try {
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "inbox", parser.parse("Subject: t\r\n\r\nhello world"));
    bayes.classify(session, f);
    assertEquals(bayes.getHistoryCount(session), 1);
    bayes.classify(session, f);
    assertEquals(bayes.getHistoryCount(session), 2);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: getHistory pagination — offset and limit work", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const files: string[] = [];
  try {
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "inbox", parser.parse("Subject: t\r\n\r\nhello world"));
    for (let i = 0; i < 5; i++) {
      const f = await makeEml(`Subject: msg${i}\r\n\r\nhello`);
      files.push(f);
      bayes.classify(session, f);
    }
    const page1 = bayes.getHistory(session, { limit: 3, offset: 0 });
    const page2 = bayes.getHistory(session, { limit: 3, offset: 3 });
    assertEquals(page1.length, 3);
    assertEquals(page2.length, 2);
    // No overlap
    const ids1 = new Set(page1.map((r) => r.id));
    assert(page2.every((r) => !ids1.has(r.id)));
  } finally {
    for (const f of files) await Deno.remove(f).catch(() => {});
    cleanup();
  }
});

Deno.test("Bayes: getHistory bucket filter narrows results", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const files: string[] = [];
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of ["buy pills cheap", "free money now"]) {
      bayes.trainMessage(session, "spam", parser.parse(`Subject: s\r\n\r\n${t}`));
    }
    for (const t of ["meeting agenda", "project update"]) {
      bayes.trainMessage(session, "inbox", parser.parse(`Subject: i\r\n\r\n${t}`));
    }
    // Classify known-spam message
    const spamFile = await makeEml("Subject: buy\r\n\r\nbuy pills cheap free money now");
    files.push(spamFile);
    bayes.classify(session, spamFile);

    const all = bayes.getHistory(session);
    const spamOnly = bayes.getHistory(session, { bucket: "spam" });
    const inboxOnly = bayes.getHistory(session, { bucket: "inbox" });
    assert(all.length >= spamOnly.length);
    assert(spamOnly.every((r) => r.bucket === "spam"));
    assert(inboxOnly.every((r) => r.bucket === "inbox"));
  } finally {
    for (const f of files) await Deno.remove(f).catch(() => {});
    cleanup();
  }
});

Deno.test("Bayes: getHistory search filter matches subject", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const files: string[] = [];
  try {
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "inbox", parser.parse("Subject: t\r\n\r\nhello world"));
    const f1 = await makeEml("Subject: hello world\r\n\r\nhello");
    const f2 = await makeEml("Subject: unrelated topic\r\n\r\nhello");
    files.push(f1, f2);
    bayes.classify(session, f1);
    bayes.classify(session, f2);
    const results = bayes.getHistory(session, { search: "hello" });
    assert(results.length >= 1);
    assert(results.every((r) => r.subject.toLowerCase().includes("hello")));
  } finally {
    for (const f of files) await Deno.remove(f).catch(() => {});
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

Deno.test("Bayes: getStats — empty database", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    const s = bayes.getStats(session);
    assertEquals(s.totalClassified, 0);
    assertEquals(s.totalRetrained, 0);
    assertEquals(s.magnetHits, 0);
    assertEquals(s.totalWords, 0);
    assertEquals(s.buckets, []);
  } finally { cleanup(); }
});

Deno.test("Bayes: getStats — word counts match training", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  try {
    bayes.createBucket(session, "inbox");
    bayes.createBucket(session, "spam");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: test\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: test\r\n\r\nmeeting agenda tuesday review"));

    const s = bayes.getStats(session);
    assertEquals(s.buckets.length, 2);

    const spamStat = s.buckets.find((b) => b.name === "spam")!;
    const inboxStat = s.buckets.find((b) => b.name === "inbox")!;
    assert(spamStat !== undefined);
    assert(inboxStat !== undefined);
    assertEquals(spamStat.wordCount, bayes.getBucketWordCount(session, "spam"));
    assertEquals(inboxStat.wordCount, bayes.getBucketWordCount(session, "inbox"));
    assertEquals(s.totalWords, spamStat.wordCount + inboxStat.wordCount);
  } finally { cleanup(); }
});

Deno.test("Bayes: getStats — totalClassified increments on classify", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy drugs\r\n\r\nbuy cheap drugs online");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: h\r\n\r\nmeeting agenda tuesday review"));

    assertEquals(bayes.getStats(session).totalClassified, 0);
    bayes.classify(session, f);
    assertEquals(bayes.getStats(session).totalClassified, 1);
    bayes.classify(session, f);
    assertEquals(bayes.getStats(session).totalClassified, 2);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: getStats — classifiedCount per bucket", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const spamTexts = [
    "buy cheap viagra online now free shipping discount pills",
    "make money fast work from home guaranteed income cash prize",
    "congratulations winner lottery prize claim your cash reward now",
  ];
  const inboxTexts = [
    "meeting agenda for tuesday please review the attached document",
    "project update the deadline has been moved to next friday morning",
    "lunch plans are you free thursday afternoon at the usual place",
  ];
  const spamEml  = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount");
  const inboxEml = await makeEml("Subject: meeting\r\n\r\nplease review the agenda for tuesday afternoon meeting");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of spamTexts)
      bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of inboxTexts)
      bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    bayes.classify(session, spamEml);
    bayes.classify(session, inboxEml);

    const s = bayes.getStats(session);
    const spamStat  = s.buckets.find((b) => b.name === "spam")!;
    const inboxStat = s.buckets.find((b) => b.name === "inbox")!;
    assertEquals(spamStat.classifiedCount,  1);
    assertEquals(inboxStat.classifiedCount, 1);
    assertEquals(s.totalClassified, 2);
  } finally {
    await Deno.remove(spamEml);
    await Deno.remove(inboxEml);
    cleanup();
  }
});

Deno.test("Bayes: getStats — totalRetrained increments on retrainHistory", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    bayes.classify(session, f);
    assertEquals(bayes.getStats(session).totalRetrained, 0);

    const [entry] = bayes.getHistory(session);
    bayes.retrainHistory(session, entry.id, "inbox");
    assertEquals(bayes.getStats(session).totalRetrained, 1);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: getStats — magnetHits increments when magnet fires", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml(
    "From: boss@company.com\r\nSubject: quarterly report\r\n\r\nbuy cheap drugs"
  );
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: h\r\n\r\nmeeting agenda tuesday review"));
    bayes.addMagnet(session, "inbox", "from", "boss@company.com");

    assertEquals(bayes.getStats(session).magnetHits, 0);
    bayes.classify(session, f);
    assertEquals(bayes.getStats(session).magnetHits, 1);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: getStats — default bucket colour is black", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    const s = bayes.getStats(session);
    assertEquals(s.buckets[0].color, "black");
  } finally { cleanup(); }
});

Deno.test("Bayes: getStats — bucket colour reflects setBucketColor", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createBucket(session, "spam");
    bayes.setBucketColor(session, "spam", "#ff0000");
    const s = bayes.getStats(session);
    assertEquals(s.buckets[0].color, "#ff0000");
  } finally { cleanup(); }
});

Deno.test("Bayes: getStats — accuracy proxy via retrain rate", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    // Classify twice, retrain once → accuracy = 50%
    bayes.classify(session, f);
    bayes.classify(session, f);
    const [, entry] = bayes.getHistory(session); // older entry
    bayes.retrainHistory(session, entry.id, "inbox");

    const s = bayes.getStats(session);
    assertEquals(s.totalClassified, 2);
    assertEquals(s.totalRetrained, 1);
    assertAlmostEquals(
      (s.totalClassified - s.totalRetrained) / s.totalClassified,
      0.5,
      0.001,
    );
  } finally { await Deno.remove(f); cleanup(); }
});

// ---------------------------------------------------------------------------
// classifyWithWordScores
// ---------------------------------------------------------------------------

Deno.test("Bayes: classifyWithWordScores — no buckets returns empty wordScores", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const f = await makeEml("Subject: test\r\n\r\nbuy cheap drugs");
  try {
    const r = bayes.classifyWithWordScores(session, f);
    assertEquals(r.bucket, "unclassified");
    assertEquals(r.wordScores, []);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — one bucket returns empty wordScores", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: test\r\n\r\nbuy cheap drugs");
  try {
    bayes.createBucket(session, "spam");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy cheap drugs online"));
    const r = bayes.classifyWithWordScores(session, f);
    assertEquals(r.wordScores, []);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — untrained words absent from wordScores", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  // "zzznever" appears in the message but was never trained
  const f = await makeEml("Subject: test\r\n\r\nbuy cheap drugs zzznever");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: h\r\n\r\nmeeting agenda tuesday review"));
    const r = bayes.classifyWithWordScores(session, f);
    assert(!r.wordScores.some((ws) => ws.word === "zzznever"),
      "untrained word should not appear in wordScores");
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — bucketProbs are P(word|bucket) not log", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  // Train "spam" bucket with "buy" appearing 4 times total across 2 messages (2+2)
  // and "inbox" with no "buy" → P(buy|spam) = 2/total_spam_words, P(buy|inbox) = 0
  const f = await makeEml("Subject: test\r\n\r\nbuy cheap");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy buy cheap cheap drugs online"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: h\r\n\r\nmeeting agenda tuesday review thursday"));

    const r = bayes.classifyWithWordScores(session, f);
    const buyScore = r.wordScores.find((ws) => ws.word === "buy");
    assert(buyScore !== undefined, "should have a score for 'buy'");

    const spamProb  = buyScore!.bucketProbs.get("spam")  ?? 0;
    const inboxProb = buyScore!.bucketProbs.get("inbox") ?? 0;

    // Probability must be in [0, 1] — not a log-probability
    assert(spamProb  >= 0 && spamProb  <= 1, `spam prob ${spamProb} out of range`);
    assert(inboxProb >= 0 && inboxProb <= 1, `inbox prob ${inboxProb} out of range`);
    assert(spamProb > inboxProb, "buy should be more probable in spam than inbox");
    assertEquals(inboxProb, 0, "buy never trained in inbox → prob should be 0");
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — topBucket is bucket with highest prob", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online discount");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    const r = bayes.classifyWithWordScores(session, f);
    assert(r.wordScores.length > 0);
    // Every spam-exclusive word should have topBucket = "spam"
    for (const ws of r.wordScores) {
      const maxProb = Math.max(...ws.bucketProbs.values());
      const expected = [...ws.bucketProbs.entries()]
        .find(([, p]) => p === maxProb)![0];
      assertEquals(ws.topBucket, expected,
        `topBucket for "${ws.word}" should be "${expected}", got "${ws.topBucket}"`);
    }
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — sorted by discriminativeness descending", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online discount meeting agenda");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
      "congratulations winner lottery prize claim your cash reward now",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
      "lunch plans are you free thursday afternoon at the usual place",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    const r = bayes.classifyWithWordScores(session, f);
    assert(r.wordScores.length >= 2);

    const disc = (ws: typeof r.wordScores[0]) =>
      (Math.max(...ws.bucketProbs.values()) - Math.min(...ws.bucketProbs.values())) * ws.freq;

    for (let i = 0; i + 1 < r.wordScores.length; i++) {
      assert(
        disc(r.wordScores[i]) >= disc(r.wordScores[i + 1]),
        `word "${r.wordScores[i].word}" (disc=${disc(r.wordScores[i]).toFixed(6)}) should not be less discriminating than "${r.wordScores[i+1].word}" (disc=${disc(r.wordScores[i+1]).toFixed(6)})`,
      );
    }
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — topN limits result length", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml(
    "Subject: buy now\r\n\r\nbuy cheap viagra online discount meeting agenda tuesday review"
  );
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    const r3 = bayes.classifyWithWordScores(session, f, 3);
    assert(r3.wordScores.length <= 3, `topN=3 should return at most 3 words, got ${r3.wordScores.length}`);

    const r1 = bayes.classifyWithWordScores(session, f, 1);
    assert(r1.wordScores.length <= 1);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — writes history", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy drugs\r\n\r\nbuy cheap drugs online");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    bayes.trainMessage(session, "spam",
      parser.parse("Subject: s\r\n\r\nbuy cheap drugs online now free"));
    bayes.trainMessage(session, "inbox",
      parser.parse("Subject: h\r\n\r\nmeeting agenda tuesday review"));

    assertEquals(bayes.getHistory(session).length, 0);
    bayes.classifyWithWordScores(session, f);
    assertEquals(bayes.getHistory(session).length, 1);
  } finally { await Deno.remove(f); cleanup(); }
});

Deno.test("Bayes: classifyWithWordScores — result matches classify", async () => {
  const { bayes, session, cleanup } = await makeStack();
  const parser = new MailParser();
  const f = await makeEml("Subject: buy now\r\n\r\nbuy cheap viagra online free shipping discount");
  try {
    bayes.createBucket(session, "spam");
    bayes.createBucket(session, "inbox");
    for (const t of [
      "buy cheap viagra online now free shipping discount pills",
      "make money fast work from home guaranteed income cash prize",
      "congratulations winner lottery prize claim your cash reward now",
    ]) bayes.trainMessage(session, "spam",  parser.parse(`Subject: t\r\n\r\n${t}`));
    for (const t of [
      "meeting agenda for tuesday please review the attached document",
      "project update the deadline has been moved to next friday morning",
      "lunch plans are you free thursday afternoon at the usual place",
    ]) bayes.trainMessage(session, "inbox", parser.parse(`Subject: t\r\n\r\n${t}`));

    const r1 = bayes.classify(session, f);
    const r2 = bayes.classifyWithWordScores(session, f);
    assertEquals(r2.bucket, r1.bucket);
    assertEquals(r2.magnetUsed, r1.magnetUsed);
  } finally { await Deno.remove(f); cleanup(); }
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

Deno.test("Bayes: loginUser returns session key for valid admin credentials", async () => {
  const { bayes, cleanup } = await makeStack();
  try {
    const key = bayes.loginUser("admin", "");
    assert(key !== null, "Expected a session key");
    // Key should work as a valid session
    assert(Array.isArray(bayes.getBuckets(key!)));
  } finally { cleanup(); }
});

Deno.test("Bayes: loginUser returns null for wrong password", async () => {
  const { bayes, cleanup } = await makeStack();
  try {
    const key = bayes.loginUser("admin", "wrongpassword");
    assertEquals(key, null);
  } finally { cleanup(); }
});

Deno.test("Bayes: loginUser returns null for nonexistent user", async () => {
  const { bayes, cleanup } = await makeStack();
  try {
    const key = bayes.loginUser("nobody", "");
    assertEquals(key, null);
  } finally { cleanup(); }
});

Deno.test("Bayes: isAdmin returns true for admin session", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    assert(bayes.isAdmin(session));
  } finally { cleanup(); }
});

Deno.test("Bayes: isAdmin returns false for non-admin session", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "alice", "pass");
    const aliceKey = bayes.loginUser("alice", "pass");
    assert(aliceKey !== null);
    assert(!bayes.isAdmin(aliceKey!));
  } finally { cleanup(); }
});

Deno.test("Bayes: getUsername returns correct name for session", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    assertEquals(bayes.getUsername(session), "admin");
  } finally { cleanup(); }
});

Deno.test("Bayes: getUsername returns null for invalid session", async () => {
  const { bayes, cleanup } = await makeStack();
  try {
    assertEquals(bayes.getUsername("bogus"), null);
  } finally { cleanup(); }
});

Deno.test("Bayes: listUsers includes admin", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    const users = bayes.listUsers(session);
    assert(users.some((u) => u.name === "admin" && u.isAdmin));
  } finally { cleanup(); }
});

Deno.test("Bayes: createUserAccount adds a new user", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "bob", "secret");
    const users = bayes.listUsers(session);
    assert(users.some((u) => u.name === "bob" && !u.isAdmin));
  } finally { cleanup(); }
});

Deno.test("Bayes: createUserAccount requires admin session", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "alice", "pass");
    const aliceKey = bayes.loginUser("alice", "pass")!;
    assertThrows(
      () => bayes.createUserAccount(aliceKey, "charlie", "pass"),
      Error, "Admin access required",
    );
  } finally { cleanup(); }
});

Deno.test("Bayes: new user can log in with correct password", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "carol", "mypass");
    const key = bayes.loginUser("carol", "mypass");
    assert(key !== null);
    assert(Array.isArray(bayes.getBuckets(key!)));
  } finally { cleanup(); }
});

Deno.test("Bayes: deleteUserAccount removes the user", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "dave", "pass");
    bayes.deleteUserAccount(session, "dave");
    const users = bayes.listUsers(session);
    assert(!users.some((u) => u.name === "dave"));
  } finally { cleanup(); }
});

Deno.test("Bayes: deleteUserAccount cannot delete admin", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    assertThrows(
      () => bayes.deleteUserAccount(session, "admin"),
      Error, "Cannot delete admin user",
    );
  } finally { cleanup(); }
});

Deno.test("Bayes: deleteUserAccount requires admin session", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "eve", "pass");
    const eveKey = bayes.loginUser("eve", "pass")!;
    assertThrows(
      () => bayes.deleteUserAccount(eveKey, "eve"),
      Error, "Admin access required",
    );
  } finally { cleanup(); }
});

Deno.test("Bayes: setPassword updates login credentials", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "frank", "oldpass");
    const key = bayes.loginUser("frank", "oldpass")!;
    bayes.setPassword(key, "newpass");
    assertEquals(bayes.loginUser("frank", "oldpass"), null);
    assert(bayes.loginUser("frank", "newpass") !== null);
  } finally { cleanup(); }
});

Deno.test("Bayes: user data is isolated — buckets not visible across users", async () => {
  const { bayes, session, cleanup } = await makeStack();
  try {
    bayes.createUserAccount(session, "grace", "pass");
    const graceKey = bayes.loginUser("grace", "pass")!;

    bayes.createBucket(session, "admin-bucket");
    bayes.createBucket(graceKey, "grace-bucket");

    assert(bayes.getBuckets(session).includes("admin-bucket"));
    assert(!bayes.getBuckets(session).includes("grace-bucket"));
    assert(bayes.getBuckets(graceKey).includes("grace-bucket"));
    assert(!bayes.getBuckets(graceKey).includes("admin-bucket"));
  } finally { cleanup(); }
});
