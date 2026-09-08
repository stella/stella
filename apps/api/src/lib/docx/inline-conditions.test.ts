import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { adaptAiFields, type AiOccurrenceAdapter } from "./adapt-ai-fields";
import {
  MAX_INLINE_NESTING,
  parseInlineConditions,
  processInlineConditions,
} from "./inline-conditions";
import { applyManifestFillSteps } from "./manifest-fill-steps";
import { paragraphText, W_NS } from "./ooxml";
import { fillTemplate } from "./patch-template";
import type { FieldMeta, TemplateData } from "./types";

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
  for (const match of xml.matchAll(
    /<w:t[^>]*?(?:\/>|>(?<text>.*?)<\/w:t>)/gu,
  )) {
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
    const text =
      "the Buyer{% if hasSpouse %} and their spouse{% endif %} hereby";
    const parsed = parseInlineConditions(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.groups).toHaveLength(1);
    const group = parsed.groups[0];
    expect(text.slice(group?.start, group?.end)).toBe(
      "{% if hasSpouse %} and their spouse{% endif %}",
    );
    if (group?.kind !== "if") {
      throw new Error("expected an inline if group");
    }
    const branch = group.branches[0];
    expect(branch?.condition).toBe("hasSpouse");
    expect(text.slice(branch?.contentStart, branch?.contentEnd)).toBe(
      " and their spouse",
    );
  });

  test("returns only the outermost group of a nested pair", () => {
    const parsed = parseInlineConditions(
      "a {% if x %}b {% if y %}c{% endif %}{% endif %}",
    );
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    // The inner block stays in the text; the next pass reads it as top-level.
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.kind).toBe("if");
    expect(parsed.groups[0]?.start).toBe(2);
  });

  test("refuses to nest past the bound", () => {
    const deep = `${"{% if x %}".repeat(MAX_INLINE_NESTING + 1)}y${"{% endif %}".repeat(MAX_INLINE_NESTING + 1)}`;
    const parsed = parseInlineConditions(deep);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain(
        `nest at most ${String(MAX_INLINE_NESTING)} deep`,
      );
    }
  });

  test("parses an inline each with content-span offsets covering the body", () => {
    const text =
      "Parties: {% for party in parties %}{{ party.name }}, {% endfor %}end";
    const parsed = parseInlineConditions(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.groups).toHaveLength(1);
    const group = parsed.groups[0];
    if (group?.kind !== "for") {
      throw new Error("expected a for group");
    }
    expect(group.arrayPath).toBe("parties");
    expect(text.slice(group.start, group.end)).toBe(
      "{% for party in parties %}{{ party.name }}, {% endfor %}",
    );
    expect(text.slice(group.contentStart, group.contentEnd)).toBe(
      "{{ party.name }}, ",
    );
  });

  test("a loop inside a condition is one outermost group", () => {
    const parsed = parseInlineConditions(
      "x {% if a %}{% for item in items %}y{% endfor %}{% endif %}",
    );
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.groups.map(({ kind }) => kind)).toEqual(["if"]);
  });

  test("a closer that does not match the open block is an error", () => {
    const parsed = parseInlineConditions("{% if a %}{% endfor %}");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Orphaned inline {% endfor %}");
    }
  });

  test("rejects an unclosed inline each, naming the paragraph", () => {
    const parsed = parseInlineConditions(
      "list: {% for item in items %} never closed",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Unclosed inline {% for %}");
      expect(parsed.directive).toBe("{% for item in items %}");
    }
  });

  test("rejects an orphaned inline each closer", () => {
    const parsed = parseInlineConditions("text {% endfor %} more");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Orphaned inline {% endfor %}");
    }
  });

  test("rejects an unclosed inline if, naming the paragraph", () => {
    const parsed = parseInlineConditions("start {% if a %} never closed");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Unclosed inline {% if %}");
      expect(parsed.message).toContain("start {% if a %} never closed");
      expect(parsed.directive).toBe("{% if a %}");
    }
  });

  test("rejects orphaned closers and branch separators", () => {
    expect(parseInlineConditions("text {% endif %} more").ok).toBe(false);
    expect(parseInlineConditions("text {% else %} more").ok).toBe(false);
    expect(parseInlineConditions("text {% elif b %} more").ok).toBe(false);
  });
});

// ── processInlineConditions ──────────────────────────────

describe("processInlineConditions", () => {
  test("keeps the span content (without markers) when the condition holds", () => {
    const body = parseBody(
      WRAP(
        P("the Buyer{% if hasSpouse %} and their spouse{% endif %} hereby."),
      ),
    );
    const errors = processInlineConditions(body, { hasSpouse: true });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["the Buyer and their spouse hereby."]);
  });

  test("cuts the whole span when the condition fails", () => {
    const body = parseBody(
      WRAP(
        P("the Buyer{% if hasSpouse %} and their spouse{% endif %} hereby."),
      ),
    );
    const errors = processInlineConditions(body, { hasSpouse: false });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["the Buyer hereby."]);
  });

  test("else branch wins when the condition fails", () => {
    const xml = WRAP(
      P(
        "Payment is due{% if hasDeadline %} by the deadline{% else %} on demand{% endif %}.",
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
        "Notice goes{% if byEmail %} by email{% elif byPost %} by post{% else %} in person{% endif %}.",
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
          "Seller{% if a %} A{% endif %} sells to Buyer{% if b %} B{% endif %} the asset.",
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
        `<w:r><w:t xml:space="preserve">the Buyer{% if has</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">Spouse %} and </w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">their spouse</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">{% endif %} hereby.</w:t></w:r>` +
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
      WRAP(P("Signed{% if isCorp %} per its directors{% endif %}.")),
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
    const original = "the Buyer{% if hasSpouse %} and their spouse hereby.";
    const body = parseBody(WRAP(P("Intro.") + P(original)));
    const errors = processInlineConditions(body, { hasSpouse: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed inline {% if %}");
    expect(errors[0]?.paragraphIndex).toBe(1);
    expect(errors[0]?.directive).toBe("{% if hasSpouse %}");
    expect(bodyTexts(body)).toEqual(["Intro.", original]);
  });

  test("resolves a condition nested inside a condition", () => {
    const body = parseBody(
      WRAP(P("a {% if x %}b {% if y %}c{% else %}d{% endif %}{% endif %}e")),
    );
    const errors = processInlineConditions(body, { x: true, y: false });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["a b de"]);
  });

  test("a loop body may condition on the item and on its position", () => {
    const body = parseBody(
      WRAP(
        P(
          "for: {% for a in attorneys %}{{ a.name }}" +
            '{% if a.role == "lead" %} (lead){% endif %}' +
            "{% if not loop.last %}, {% endif %}{% endfor %}.",
        ),
      ),
    );
    const errors = processInlineConditions(body, {
      attorneys: [
        { name: "Alice", role: "lead" },
        { name: "Bob", role: "associate" },
      ],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["for: Alice (lead), Bob."]);
  });

  test("a nested loop's counters bind to the nested loop", () => {
    const body = parseBody(
      WRAP(
        P(
          "{% for g in groups %}[{% for i in g.items %}{{ loop.index }}" +
            "{% if not loop.last %}-{% endif %}{% endfor %}]{% endfor %}",
        ),
      ),
    );
    const errors = processInlineConditions(body, {
      groups: [{ items: [{}, {}] }, { items: [{}, {}, {}] }],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["[1-2][1-2-3]"]);
  });

  test("expands an inline each over a record array, repeating separators", () => {
    const body = parseBody(
      WRAP(
        P(
          "Parties: {% for party in parties %}{{ party.name }}, {% endfor %}signed.",
        ),
      ),
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
          "Roster: {% for item in people %}{{ item.name }} ({{ item.role }}); {% endfor %}done.",
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
      WRAP(
        P(
          "Parties: {% for party in parties %}{{ party.name }}, {% endfor %}none.",
        ),
      ),
    );
    const errors = processInlineConditions(body, { parties: [] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Parties: none."]);
  });

  test("expands an inline each over a primitive array via .value", () => {
    const body = parseBody(
      WRAP(P("Tags: {% for tag in tags %}{{ tag.value }} {% endfor %}end.")),
    );
    const errors = processInlineConditions(body, {
      tags: ["alpha", "beta"],
    });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Tags: alpha beta end."]);
  });

  test("treats a non-array each path as an empty span", () => {
    const body = parseBody(
      WRAP(P("X: {% for item in missing %}{{ item.name }}, {% endfor %}Y.")),
    );
    const errors = processInlineConditions(body, {});
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["X: Y."]);
  });

  test("resolves an inline each alongside an inline if in one paragraph", () => {
    const body = parseBody(
      WRAP(
        P(
          "Sellers: {% for seller in sellers %}{{ seller.name }}, {% endfor %}{% if notarised %}(notarised){% endif %}.",
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
    const original =
      "list: {% for item in items %}{{ item.name }}, never closed.";
    const body = parseBody(WRAP(P("Intro.") + P(original)));
    const errors = processInlineConditions(body, { items: [{ name: "A" }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed inline {% for %}");
    expect(errors[0]?.paragraphIndex).toBe(1);
    expect(bodyTexts(body)).toEqual(["Intro.", original]);
  });

  test("skips whole-paragraph directive lines (block engine territory)", () => {
    // An orphaned whole-line {% endif %} is parseBlockTree's error, not ours.
    const body = parseBody(WRAP(P("{% endif %}") + P("Plain text.")));
    const errors = processInlineConditions(body, {});
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["{% endif %}", "Plain text."]);
  });

  test("resolves {{ loop.index }} (1-based) and {{ loop.length }} inside an inline each", () => {
    const body = parseBody(
      WRAP(
        P(
          "Rows: {% for row in rows %}{{ loop.index }}/{{ loop.length }} {% endfor %}done.",
        ),
      ),
    );
    const errors = processInlineConditions(body, { rows: [{}, {}, {}] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Rows: 1/3 2/3 3/3 done."]);
  });

  test("renders an empty array span with no iteration tokens", () => {
    const body = parseBody(
      WRAP(P("Rows: {% for row in rows %}{{ loop.index }} {% endfor %}none.")),
    );
    const errors = processInlineConditions(body, { rows: [] });
    expect(errors).toEqual([]);
    expect(bodyTexts(body)).toEqual(["Rows: none."]);
  });

  test("preserves a bold run inside an inline each body for every item", () => {
    // Body: bold "{{p.name}}" run + plain "; " run, repeated per item.
    const xml = WRAP(
      `<w:p>` +
        `<w:r><w:t xml:space="preserve">Parties: {% for item in p %}</w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{ item.name }}</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">; {% endfor %}done.</w:t></w:r>` +
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
        `<w:r><w:t xml:space="preserve">{% for item in p %}</w:t></w:r>` +
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{ item.name }}</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">, {% endfor %}end.</w:t></w:r>` +
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

  test("preserves formatting alongside {{ loop.index }} and an inline num()", async () => {
    const docx = await makeDocx(
      WRAP(
        `<w:p>` +
          `<w:r><w:t xml:space="preserve">List: {% for item in p %}{{ loop.index }}. {{ num("c") }} </w:t></w:r>` +
          `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{ item.name }}</w:t></w:r>` +
          `<w:r><w:t xml:space="preserve">; {% endfor %}end.</w:t></w:r>` +
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

  test("{{ loop.index }} composes with an item field in an inline each", () => {
    const body = parseBody(
      WRAP(
        P(
          "List: {% for item in p %}{{ loop.index }}. {{ item.name }}; {% endfor %}end.",
        ),
      ),
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
          "the Buyer {{buyer_name}}{% if has_spouse %} and their spouse {{spouse_name}}{% endif %} hereby agree.",
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

  test("an inline loop numbers loop-local num() sequentially per item", async () => {
    const docx = await makeDocx(
      WRAP(
        P(
          "Items: {% for item in items %}Clause {{ num('item') }} ({{ item.name }}); {% endfor %}end.",
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

  test("inline each resolves {{ loop.index }}/{{ loop.length }} through fillTemplate", async () => {
    // Leading text keeps the paragraph off the block engine's
    // whole-line-directive path, so the each stays inline.
    const docx = await makeDocx(
      WRAP(
        P(
          "List: {% for item in items %}{{ loop.index }}/{{ loop.length }}: {{ item.name }}. {% endfor %}",
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
          "Signed by {% for signer in signers %}{{ signer.name }} ({{ signer.title }}), {% endfor %}this day.",
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
        P("{% if include_clause %}") +
          P(
            "The Seller{% if has_agent %} via their agent{% endif %} warrants.",
          ) +
          P("{% endif %}") +
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

  test("inline conditions inside block loops retain each row context", async () => {
    const docx = await makeDocx(
      WRAP(
        P("{% for seller in sellers %}") +
          P("{{ seller.name }}{% if seller.is_company %} Ltd{% endif %}.") +
          P("{% endfor %}"),
      ),
    );

    const result = await fillTemplate(docx, {
      sellers: [
        { name: "Acme", is_company: true },
        { name: "Alice", is_company: false },
      ],
    });

    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe("Acme Ltd.Alice.");
  });

  test("inline loops inside block rows use each row's nested array", async () => {
    const docx = await makeDocx(
      WRAP(
        P("{% for group in groups %}") +
          P("Items: {% for item in items %}{{ item.name }}, {% endfor %}") +
          P("{% endfor %}"),
      ),
    );

    const result = await fillTemplate(docx, {
      groups: [
        { items: [{ name: "Alpha" }] },
        { items: [{ name: "Beta" }, { name: "Gamma" }] },
      ],
    });

    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "Items: Alpha, Items: Beta, Gamma, ",
    );
  });

  test("surfaces inline structure errors through fillTemplate", async () => {
    const docx = await makeDocx(
      WRAP(P("Broken{% if oops %} span without closer.")),
    );
    const { structureErrors } = await fillTemplate(docx, { oops: true });
    expect(structureErrors).toHaveLength(1);
    expect(structureErrors[0]?.message).toContain("Unclosed inline {% if %}");
  });

  test("aiAdapt per-occurrence renderings inside a cut branch are removed with it", async () => {
    // adaptAiFields runs at the fill boundary BEFORE fillTemplate, on the raw
    // template buffer: extraction and per-occurrence patching see the same
    // buffer, so occurrence indices stay aligned regardless of what the
    // inline pass cuts afterwards.
    const docx = await makeDocx(
      WRAP(
        P("Governed by {{law}}.") +
          P(
            "Spousal property{% if has_spouse %} follows {{law}} rules{% endif %}.",
          ),
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

  test("inline {% if dateField > ... %} compares the raw ISO, not the formatted date", async () => {
    // End-to-end through the boundary recipe: the fill steps format the date in
    // place AND stash its raw ISO (CONDITION_RAW_VALUES); fillTemplate reads the
    // overlay so the inline ordering test runs on the ISO value while the
    // {{signing_date}} marker substitutes the localized display text. The
    // boolean `notify` keeps a non-string value in the map so fillTemplate
    // routes through block/inline processing (an all-string map is treated as
    // pre-expanded patch values), mirroring a real template fill.
    const docx = await makeDocx(
      WRAP(
        P(
          'Signed {{signing_date}}{% if signing_date > "2028-01-01" %} (after cutoff){% else %} (before cutoff){% endif %}.',
        ) +
          P("{% if notify %}") +
          P("Notice sent.") +
          P("{% endif %}"),
      ),
    );
    const dateField: FieldMeta = {
      path: "signing_date",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
    };

    const values: TemplateData = { signing_date: "2028-06-13", notify: true };
    const stepError = await applyManifestFillSteps({
      values,
      manifest: { fields: [dateField] },
      resolveLookup: () => {
        throw new Error("no lookup field in this manifest");
      },
    });
    expect(stepError).toBeNull();

    const result = await fillTemplate(docx, values);
    expect(result.structureErrors).toEqual([]);
    expect(await documentText(result.buffer)).toBe(
      "Signed 13. června 2028 (after cutoff).Notice sent.",
    );
  });

  test("a day-first date compares as the ISO date it names, not as its spelling", async () => {
    // `13. 6. 2028` sorts before "2028-01-01" as a string, so a stash that
    // kept the submitted spelling would take the else branch. What the value
    // NAMES is what the condition compares.
    const docx = await makeDocx(
      WRAP(
        P(
          'Signed {{signing_date}}{% if signing_date > "2028-01-01" %} (after cutoff){% else %} (before cutoff){% endif %}.',
        ) + P("{% if notify %}{% endif %}"),
      ),
    );
    const values: TemplateData = { signing_date: "13. 6. 2028", notify: true };
    const stepError = await applyManifestFillSteps({
      values,
      manifest: {
        fields: [
          {
            path: "signing_date",
            inputType: "date",
            dateFormat: { locale: "cs", style: "long" },
          },
        ],
      },
      resolveLookup: () => {
        throw new Error("no lookup field in this manifest");
      },
    });
    expect(stepError).toBeNull();

    const result = await fillTemplate(docx, values);
    expect(await documentText(result.buffer)).toBe(
      "Signed 13. června 2028 (after cutoff).",
    );
  });
});
