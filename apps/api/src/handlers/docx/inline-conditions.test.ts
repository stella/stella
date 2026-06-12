import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { adaptAiFields, type AiOccurrenceAdapter } from "./adapt-ai-fields";
import {
  parseInlineConditions,
  processInlineConditions,
} from "./inline-conditions";
import { paragraphText, W_NS } from "./ooxml";
import { fillTemplate } from "./patch-template";

// ── Helpers ──────────────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const parseBody = (xml: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  return body;
};

const bodyTexts = (body: slimdom.Element): string[] =>
  [...body.getElementsByTagNameNS(W_NS, "p")].map((p) => paragraphText(p));

/** Text of every run carrying a `<w:b/>` (bold) property, in document order. */
const boldRunTexts = (body: slimdom.Element): string[] => {
  const texts: string[] = [];
  for (const run of body.getElementsByTagNameNS(W_NS, "r")) {
    const rPr = run.getElementsByTagNameNS(W_NS, "rPr").at(0);
    if (!rPr || rPr.getElementsByTagNameNS(W_NS, "b").length === 0) {
      continue;
    }
    const text = run
      .getElementsByTagNameNS(W_NS, "t")
      .map((t) => t.textContent ?? "")
      .join("");
    if (text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
};

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const documentText = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const texts: string[] = [];
  // Cut spans leave empty self-closing <w:t/> runs behind; match both forms.
  for (const match of xml.matchAll(/<w:t[^>]*?(?:\/>|>(.*?)<\/w:t>)/gu)) {
    texts.push(match[1] ?? "");
  }
  return texts.join("");
};

const documentBody = async (buffer: Buffer): Promise<slimdom.Element> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return parseBody(xml);
};

// ── parseInlineConditions ────────────────────────────────

describe("parseInlineConditions", () => {
  test("parses a single span with offsets covering the markers", () => {
    const text = "the Buyer{{#if hasSpouse}} and their spouse{{/if}} hereby";
    const parsed = parseInlineConditions(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.groups).toHaveLength(1);
    const group = parsed.groups[0];
    expect(text.slice(group?.start, group?.end)).toBe(
      "{{#if hasSpouse}} and their spouse{{/if}}",
    );
    const branch = group?.branches[0];
    expect(branch?.condition).toBe("hasSpouse");
    expect(text.slice(branch?.contentStart, branch?.contentEnd)).toBe(
      " and their spouse",
    );
  });

  test("rejects nested inline ifs", () => {
    const parsed = parseInlineConditions(
      "a {{#if x}}b {{#if y}}c{{/if}}{{/if}}",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Nested inline {{#if}}");
    }
  });

  test("parses an inline each with content-span offsets covering the body", () => {
    const text = "Parties: {{#each parties}}{{parties.name}}, {{/each}}end";
    const parsed = parseInlineConditions(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.groups).toHaveLength(1);
    const group = parsed.groups[0];
    if (group?.kind !== "each") {
      throw new Error("expected an each group");
    }
    expect(group.arrayPath).toBe("parties");
    expect(text.slice(group.start, group.end)).toBe(
      "{{#each parties}}{{parties.name}}, {{/each}}",
    );
    expect(text.slice(group.contentStart, group.contentEnd)).toBe(
      "{{parties.name}}, ",
    );
  });

  test("rejects an inline each nested inside an inline if", () => {
    const parsed = parseInlineConditions(
      "x {{#if a}}{{#each items}}y{{/each}}{{/if}}",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Nested inline {{#each}}");
    }
  });

  test("rejects an unclosed inline each, naming the paragraph", () => {
    const parsed = parseInlineConditions("list: {{#each items}} never closed");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Unclosed inline {{#each}}");
      expect(parsed.directive).toBe("{{#each items}}");
    }
  });

  test("rejects an orphaned inline each closer", () => {
    const parsed = parseInlineConditions("text {{/each}} more");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Orphaned inline {{/each}}");
    }
  });

  test("rejects an unclosed inline if, naming the paragraph", () => {
    const parsed = parseInlineConditions("start {{#if a}} never closed");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Unclosed inline {{#if}}");
      expect(parsed.message).toContain("start {{#if a}} never closed");
      expect(parsed.directive).toBe("{{#if a}}");
    }
  });

  test("rejects orphaned closers and branch separators", () => {
    expect(parseInlineConditions("text {{/if}} more").ok).toBe(false);
    expect(parseInlineConditions("text {{#else}} more").ok).toBe(false);
    expect(parseInlineConditions("text {{#elseif b}} more").ok).toBe(false);
  });
});

// ── processInlineConditions ──────────────────────────────

describe("processInlineConditions", () => {
  test("keeps the span content (without markers) when the condition holds", () => {
    const body = parseBody(
      WRAP(P("the Buyer{{#if hasSpouse}} and their spouse{{/if}} hereby.")),
    );
    const errors = processInlineConditions(body, { hasSpouse: true });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["the Buyer and their spouse hereby."]);
  });

  test("cuts the whole span when the condition fails", () => {
    const body = parseBody(
      WRAP(P("the Buyer{{#if hasSpouse}} and their spouse{{/if}} hereby.")),
    );
    const errors = processInlineConditions(body, { hasSpouse: false });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["the Buyer hereby."]);
  });

  test("else branch wins when the condition fails", () => {
    const xml = WRAP(
      P(
        "Payment is due{{#if hasDeadline}} by the deadline{{#else}} on demand{{/if}}.",
      ),
    );

    const whenTrue = parseBody(xml);
    processInlineConditions(whenTrue, { hasDeadline: true });
    expect(bodyTexts(whenTrue)).toEqual(["Payment is due by the deadline."]);

    const whenFalse = parseBody(xml);
    processInlineConditions(whenFalse, { hasDeadline: false });
    expect(bodyTexts(whenFalse)).toEqual(["Payment is due on demand."]);
  });

  test("elseif picks the first matching branch", () => {
    const xml = WRAP(
      P(
        "Notice goes{{#if byEmail}} by email{{#elseif byPost}} by post{{#else}} in person{{/if}}.",
      ),
    );

    const middle = parseBody(xml);
    processInlineConditions(middle, { byEmail: false, byPost: true });
    expect(bodyTexts(middle)).toEqual(["Notice goes by post."]);

    const fallback = parseBody(xml);
    processInlineConditions(fallback, { byEmail: false, byPost: false });
    expect(bodyTexts(fallback)).toEqual(["Notice goes in person."]);
  });

  test("resolves several independent spans in one paragraph", () => {
    const body = parseBody(
      WRAP(
        P(
          "Seller{{#if a}} A{{/if}} sells to Buyer{{#if b}} B{{/if}} the asset.",
        ),
      ),
    );
    const errors = processInlineConditions(body, { a: false, b: true });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Seller sells to Buyer B the asset."]);
  });

  test("handles markers split across runs and keeps run formatting", () => {
    const xml = WRAP(
      `<w:p>` +
        `<w:r><w:t xml:space="preserve">the Buyer{{#if has</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">Spouse}} and </w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">their spouse</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">{{/if}} hereby.</w:t></w:r>` +
        `</w:p>`,
    );

    const kept = parseBody(xml);
    expect(processInlineConditions(kept, { hasSpouse: true })).toEqual([]);
    expect(bodyTexts(kept)).toEqual(["the Buyer and their spouse hereby."]);
    // The bold run inside the kept branch survives with its formatting.
    const keptDoc = kept.ownerDocument;
    expect(
      keptDoc ? slimdom.serializeToWellFormedString(keptDoc) : "",
    ).toContain("<w:b/>");

    const cut = parseBody(xml);
    expect(processInlineConditions(cut, { hasSpouse: false })).toEqual([]);
    expect(bodyTexts(cut)).toEqual(["the Buyer hereby."]);
  });

  test("evaluates manifest named conditions", () => {
    const body = parseBody(
      WRAP(P("Signed{{#if isCorp}} per its directors{{/if}}.")),
    );
    const errors = processInlineConditions(
      body,
      { entity_type: "corporation" },
      [{ name: "isCorp", expression: 'entity_type == "corporation"' }],
    );
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Signed per its directors."]);
  });

  test("reports an unclosed inline if and leaves the paragraph untouched", () => {
    const original = "the Buyer{{#if hasSpouse}} and their spouse hereby.";
    const body = parseBody(WRAP(P("Intro.") + P(original)));
    const errors = processInlineConditions(body, { hasSpouse: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed inline {{#if}}");
    expect(errors[0]?.paragraphIndex).toBe(1);
    expect(errors[0]?.directive).toBe("{{#if hasSpouse}}");
    expect(bodyTexts(body)).toEqual(["Intro.", original]);
  });

  test("reports nested inline ifs as structure errors", () => {
    const nested = "a {{#if x}}b {{#if y}}c{{/if}}{{/if}}";
    const body = parseBody(WRAP(P(nested)));
    const errors = processInlineConditions(body, { x: true });
    expect(errors.map((e) => e.paragraphIndex)).toEqual([0]);
    expect(errors[0]?.message).toContain("Nested inline {{#if}}");
    // The paragraph stays untouched.
    expect(bodyTexts(body)).toEqual([nested]);
  });

  test("expands an inline each over a record array, repeating separators", () => {
    const body = parseBody(
      WRAP(P("Parties: {{#each parties}}{{parties.name}}, {{/each}}signed.")),
    );
    const errors = processInlineConditions(body, {
      parties: [{ name: "Alice" }, { name: "Bob" }, { name: "Carol" }],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Parties: Alice, Bob, Carol, signed."]);
  });

  test("resolves multiple item fields inside an inline each body", () => {
    const body = parseBody(
      WRAP(
        P(
          "Roster: {{#each people}}{{people.name}} ({{people.role}}); {{/each}}done.",
        ),
      ),
    );
    const errors = processInlineConditions(body, {
      people: [
        { name: "Alice", role: "Buyer" },
        { name: "Bob", role: "Seller" },
      ],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual([
      "Roster: Alice (Buyer); Bob (Seller); done.",
    ]);
  });

  test("renders an empty array as an empty span", () => {
    const body = parseBody(
      WRAP(P("Parties: {{#each parties}}{{parties.name}}, {{/each}}none.")),
    );
    const errors = processInlineConditions(body, { parties: [] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Parties: none."]);
  });

  test("expands an inline each over a primitive array via .value", () => {
    const body = parseBody(
      WRAP(P("Tags: {{#each tags}}{{tags.value}} {{/each}}end.")),
    );
    const errors = processInlineConditions(body, {
      tags: ["alpha", "beta"],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Tags: alpha beta end."]);
  });

  test("treats a non-array each path as an empty span", () => {
    const body = parseBody(
      WRAP(P("X: {{#each missing}}{{missing.name}}, {{/each}}Y.")),
    );
    const errors = processInlineConditions(body, {});
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["X: Y."]);
  });

  test("resolves an inline each alongside an inline if in one paragraph", () => {
    const body = parseBody(
      WRAP(
        P(
          "Sellers: {{#each sellers}}{{sellers.name}}, {{/each}}{{#if notarised}}(notarised){{/if}}.",
        ),
      ),
    );
    const errors = processInlineConditions(body, {
      sellers: [{ name: "Alice" }, { name: "Bob" }],
      notarised: true,
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Sellers: Alice, Bob, (notarised)."]);
  });

  test("reports an unclosed inline each and leaves the paragraph untouched", () => {
    const original = "list: {{#each items}}{{items.name}}, never closed.";
    const body = parseBody(WRAP(P("Intro.") + P(original)));
    const errors = processInlineConditions(body, { items: [{ name: "A" }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed inline {{#each}}");
    expect(errors[0]?.paragraphIndex).toBe(1);
    expect(bodyTexts(body)).toEqual(["Intro.", original]);
  });

  test("skips whole-paragraph directive lines (block engine territory)", () => {
    // An orphaned whole-line {{/if}} is parseBlockTree's error, not ours.
    const body = parseBody(WRAP(P("{{/if}}") + P("Plain text.")));
    const errors = processInlineConditions(body, {});
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["{{/if}}", "Plain text."]);
  });

  test("resolves {{@index}} (1-based) and {{@count}} inside an inline each", () => {
    const body = parseBody(
      WRAP(P("Rows: {{#each rows}}{{@index}}/{{@count}} {{/each}}done.")),
    );
    const errors = processInlineConditions(body, { rows: [{}, {}, {}] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Rows: 1/3 2/3 3/3 done."]);
  });

  test("renders an empty array span with no iteration tokens", () => {
    const body = parseBody(
      WRAP(P("Rows: {{#each rows}}{{@index}} {{/each}}none.")),
    );
    const errors = processInlineConditions(body, { rows: [] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Rows: none."]);
  });

  test("preserves a bold run inside an inline each body for every item", () => {
    // Body: bold "{{p.name}}" run + plain "; " run, repeated per item.
    const xml = WRAP(
      `<w:p>` +
        `<w:r><w:t xml:space="preserve">Parties: {{#each p}}</w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{p.name}}</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">; {{/each}}done.</w:t></w:r>` +
        `</w:p>`,
    );
    const body = parseBody(xml);
    const errors = processInlineConditions(body, {
      p: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Parties: Alice; Bob; done."]);

    // Every item's name run carries <w:b/>; the separators stay plain.
    const boldNames = boldRunTexts(body);
    expect(boldNames).toEqual(["Alice", "Bob"]);
  });

  test("preserves mixed formatting across the each body per item", () => {
    // Body: bold "{{p.name}}" + plain ", " — both repeat with formatting intact.
    const xml = WRAP(
      `<w:p>` +
        `<w:r><w:t xml:space="preserve">{{#each p}}</w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{p.name}}</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">, {{/each}}end.</w:t></w:r>` +
        `</w:p>`,
    );
    const body = parseBody(xml);
    const errors = processInlineConditions(body, {
      p: [{ name: "Alice" }, { name: "Bob" }, { name: "Carol" }],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Alice, Bob, Carol, end."]);
    expect(boldRunTexts(body)).toEqual(["Alice", "Bob", "Carol"]);
  });

  test("preserves formatting alongside {{@index}} and an inline {{@num}}", async () => {
    const docx = await makeDocx(
      WRAP(
        `<w:p>` +
          `<w:r><w:t xml:space="preserve">List: {{#each p}}{{@index}}. {{@num:c}} </w:t></w:r>` +
          `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{p.name}}</w:t></w:r>` +
          `<w:r><w:t xml:space="preserve">; {{/each}}end.</w:t></w:r>` +
          `</w:p>`,
      ),
    );
    const result = await fillTemplate(docx, {
      p: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "List: 1. 1 Alice; 2. 2 Bob; end.",
    );
    // The bold name run survives serialization for both expanded items.
    const filledBody = await documentBody(result.buffer);
    expect(boldRunTexts(filledBody)).toEqual(["Alice", "Bob"]);
  });

  test("{{@index}} composes with an item field in an inline each", () => {
    const body = parseBody(
      WRAP(P("List: {{#each p}}{{@index}}. {{p.name}}; {{/each}}end.")),
    );
    const errors = processInlineConditions(body, {
      p: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["List: 1. Alice; 2. Bob; end."]);
  });
});

// ── fillTemplate integration (ordering) ──────────────────

describe("fillTemplate with inline conditions", () => {
  test("inline spans resolve before {{path}} substitution and diagnostics", async () => {
    const docx = await makeDocx(
      WRAP(
        P(
          "the Buyer {{buyer_name}}{{#if has_spouse}} and their spouse {{spouse_name}}{{/if}} hereby agree.",
        ),
      ),
    );

    const kept = await fillTemplate(docx, {
      buyer_name: "Jan Novák",
      has_spouse: true,
      spouse_name: "Jana Nováková",
    });
    expect(kept.structureErrors).toEqual([]);
    expect(await documentText(kept.buffer)).toBe(
      "the Buyer Jan Novák and their spouse Jana Nováková hereby agree.",
    );

    const cut = await fillTemplate(docx, {
      buyer_name: "Jan Novák",
      has_spouse: false,
      spouse_name: "Jana Nováková",
    });
    expect(await documentText(cut.buffer)).toBe(
      "the Buyer Jan Novák hereby agree.",
    );
    // The cut branch's marker was removed before discovery, so it is not
    // reported as unmatched; its value surfaces as unused instead.
    expect(cut.unmatchedPlaceholders).toEqual([]);
    expect(cut.unusedValues).toContain("spouse_name");
  });

  test("inline each numbers loop-local {{@num}} sequentially per item", async () => {
    const docx = await makeDocx(
      WRAP(
        P(
          "Items: {{#each items}}Clause {{@num:item}} ({{items.name}}); {{/each}}end.",
        ),
      ),
    );
    const result = await fillTemplate(docx, {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "Items: Clause 1 (A); Clause 2 (B); Clause 3 (C); end.",
    );
  });

  test("inline each resolves {{@index}}/{{@count}} through fillTemplate", async () => {
    // Leading text keeps the paragraph off the block engine's
    // whole-line-directive path, so the each stays inline.
    const docx = await makeDocx(
      WRAP(
        P(
          "List: {{#each items}}{{@index}}/{{@count}}: {{items.name}}. {{/each}}",
        ),
      ),
    );
    const result = await fillTemplate(docx, {
      items: [{ name: "Alpha" }, { name: "Beta" }],
    });
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "List: 1/2: Alpha. 2/2: Beta. ",
    );
  });

  test("expands an inline each end-to-end through fillTemplate", async () => {
    const docx = await makeDocx(
      WRAP(
        P(
          "Signed by {{#each signers}}{{signers.name}} ({{signers.title}}), {{/each}}this day.",
        ),
      ),
    );

    const result = await fillTemplate(docx, {
      signers: [
        { name: "Jan Novák", title: "Director" },
        { name: "Eva Malá", title: "Secretary" },
      ],
    });
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "Signed by Jan Novák (Director), Eva Malá (Secretary), this day.",
    );
  });

  test("composes with block directives in the same document", async () => {
    const docx = await makeDocx(
      WRAP(
        P("{{#if include_clause}}") +
          P("The Seller{{#if has_agent}} via their agent{{/if}} warrants.") +
          P("{{/if}}") +
          P("Closing."),
      ),
    );

    const result = await fillTemplate(docx, {
      include_clause: true,
      has_agent: false,
    });
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "The Seller warrants.Closing.",
    );
  });

  test("surfaces inline structure errors through fillTemplate", async () => {
    const docx = await makeDocx(
      WRAP(P("Broken{{#if oops}} span without closer.")),
    );
    const { structureErrors } = await fillTemplate(docx, { oops: true });
    expect(structureErrors).toHaveLength(1);
    expect(structureErrors[0]?.message).toContain("Unclosed inline {{#if}}");
  });

  test("aiAdapt per-occurrence renderings inside a cut branch are removed with it", async () => {
    // adaptAiFields runs at the fill boundary BEFORE fillTemplate, on the raw
    // template buffer: extraction and per-occurrence patching see the same
    // buffer, so occurrence indices stay aligned regardless of what the
    // inline pass cuts afterwards.
    const docx = await makeDocx(
      WRAP(
        P("Governed by {{law}}.") +
          P("Spousal property{{#if has_spouse}} follows {{law}} rules{{/if}}."),
      ),
    );

    const adapter: AiOccurrenceAdapter = async ({ occurrences }) =>
      occurrences.map((_, i) => `RENDERING-${String(i + 1)}`);
    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [{ path: "law", aiAdapt: true }],
      values: { law: "czech law", has_spouse: false },
      adapt: adapter,
    });
    expect(adapted.adaptedPaths).toEqual(["law"]);

    const filled = await fillTemplate(adapted.buffer, {
      law: "czech law",
      has_spouse: false,
    });
    const text = await documentText(filled.buffer);
    expect(text).toBe("Governed by RENDERING-1.Spousal property.");
    expect(text).not.toContain("RENDERING-2");
  });
});
