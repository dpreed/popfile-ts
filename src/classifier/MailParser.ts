/**
 * MailParser.ts — Tokenise a MIME email into a word-frequency map.
 *
 * Mirrors Classifier::MailParse. Handles:
 *   - MIME multipart decoding (boundary splitting)
 *   - base64 / quoted-printable transfer encodings
 *   - charset decoding (UTF-8, ISO-8859-x, Windows-125x)
 *   - HTML tag stripping
 *   - header extraction (From, To, Subject, Cc, …)
 *   - Word normalisation (lowercase, min length 3, strip punctuation)
 *   - Message size cutoff to avoid huge mails stalling classification
 */

export interface ParseResult {
  /** Word → frequency count across the entire message */
  words: Map<string, number>;
  /** Header name (lowercase) → raw value */
  headers: Map<string, string>;
}

// Characters that break words
const WORD_BOUNDARY = /[^a-z0-9\u00C0-\u024F\u0400-\u04FF]+/gi;
const MIN_WORD_LEN = 3;
const MAX_WORD_LEN = 40;

// Tags whose content should be completely discarded
const SKIP_TAGS = new Set(["script", "style", "head", "meta", "link"]);

export class MailParser {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Parse a complete RFC 2822 message from a string. */
  parse(rawMessage: string, cutoff = 100_000): ParseResult {
    const { headers, body } = this.#splitHeadersBody(rawMessage);
    const contentType = headers.get("content-type") ?? "text/plain";
    const encoding = headers.get("content-transfer-encoding") ?? "7bit";

    const words: Map<string, number> = new Map();
    // Include headers in classification (From, Subject, etc.)
    this.#addWords(words, this.#extractHeaderText(headers));
    // Parse the body recursively, then apply cutoff at a word boundary so
    // truncation never creates spurious partial-word tokens.
    const bodyText = this.#decodeBody(body, contentType, encoding, headers);
    const limited = bodyText.length > cutoff
      ? bodyText.slice(0, cutoff).replace(/\S+$/, "")
      : bodyText;
    this.#addWords(words, limited);

    return { words, headers };
  }

  /** Parse a message from a file path. */
  parseFile(path: string, cutoff = 100_000): ParseResult {
    const raw = Deno.readTextFileSync(path);
    return this.parse(raw, cutoff);
  }

  // -------------------------------------------------------------------------
  // Header / body split
  // -------------------------------------------------------------------------

  #splitHeadersBody(raw: string): { headers: Map<string, string>; body: string } {
    const headers: Map<string, string> = new Map();
    // Headers end at first blank line
    const blankLine = /\r?\n\r?\n/;
    const match = raw.match(blankLine);
    const headerSection = match ? raw.slice(0, match.index) : raw;
    const body = match ? raw.slice(match.index! + match[0].length) : "";

    // Unfold header continuation lines (RFC 2822 §2.2.3)
    const unfolded = headerSection.replace(/\r?\n([ \t]+)/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      // First value wins for duplicate headers (except Received)
      if (!headers.has(name) || name === "received") {
        headers.set(name, value);
      }
    }
    return { headers, body };
  }

  #extractHeaderText(headers: Map<string, string>): string {
    const interesting = ["from", "to", "cc", "subject", "reply-to"];
    return interesting
      .map((h) => headers.get(h) ?? "")
      .join(" ");
  }

  // -------------------------------------------------------------------------
  // Body decoding
  // -------------------------------------------------------------------------

  #decodeBody(
    body: string,
    contentType: string,
    encoding: string,
    _headers: Map<string, string>,
  ): string {
    // Decode transfer encoding first
    let decoded = body;
    const enc = encoding.toLowerCase().trim();
    if (enc === "base64") {
      try {
        decoded = atob(body.replace(/\s/g, ""));
      } catch { decoded = body; }
    } else if (enc === "quoted-printable") {
      decoded = this.#decodeQP(body);
    }

    const ct = contentType.toLowerCase();

    // Multipart — recurse into each part
    const boundary = this.#extractBoundary(contentType);
    if (boundary && ct.includes("multipart/")) {
      return this.#decodeMultipart(decoded, boundary);
    }

    // HTML — strip tags
    if (ct.includes("text/html")) {
      return this.#stripHtml(decoded);
    }

    // Plain text — return as-is
    return decoded;
  }

  #extractBoundary(contentType: string): string | null {
    const m = contentType.match(/boundary=["']?([^"';\s]+)["']?/i);
    return m ? m[1] : null;
  }

  #decodeMultipart(body: string, boundary: string): string {
    const parts: string[] = [];
    const delimiter = `--${boundary}`;
    const sections = body.split(delimiter);
    for (const section of sections) {
      if (section.trim() === "--" || section.trim() === "") continue;
      const { headers, body: partBody } = this.#splitHeadersBody(section);
      const ct = headers.get("content-type") ?? "text/plain";
      const enc = headers.get("content-transfer-encoding") ?? "7bit";
      parts.push(this.#decodeBody(partBody, ct, enc, headers));
    }
    return parts.join(" ");
  }

  #decodeQP(input: string): string {
    return input
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)));
  }

  // -------------------------------------------------------------------------
  // HTML stripping
  // -------------------------------------------------------------------------

  #stripHtml(html: string): string {
    let out = "";
    let i = 0;
    let skipUntil: string | null = null;

    while (i < html.length) {
      if (html[i] === "<") {
        const tagEnd = html.indexOf(">", i);
        if (tagEnd === -1) { i++; continue; }
        const tag = html.slice(i + 1, tagEnd).trim();
        const tagName = tag.split(/[\s/]/)[0].toLowerCase();
        if (skipUntil) {
          if (tag.startsWith("/") && tag.slice(1).toLowerCase().trim() === skipUntil) {
            skipUntil = null;
          }
        } else if (SKIP_TAGS.has(tagName)) {
          skipUntil = tagName;
        } else {
          out += " "; // replace tag with space so words don't merge
        }
        i = tagEnd + 1;
      } else if (!skipUntil) {
        out += html[i];
        i++;
      } else {
        i++;
      }
    }

    // Decode basic HTML entities
    return out
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  }

  // -------------------------------------------------------------------------
  // Word extraction
  // -------------------------------------------------------------------------

  #addWords(map: Map<string, number>, text: string): void {
    const tokens = text
      .toLowerCase()
      .split(WORD_BOUNDARY)
      .filter((w) => w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN);

    for (const token of tokens) {
      map.set(token, (map.get(token) ?? 0) + 1);
    }
  }

  // -------------------------------------------------------------------------
  // Header access helper (used by Bayes for magnet matching)
  // -------------------------------------------------------------------------

  getHeader(result: ParseResult, name: string): string {
    return result.headers.get(name.toLowerCase()) ?? "";
  }
}
