import { describe, expect, test } from "bun:test";

import { type Block, plainTextOf } from "@stll/legal-ast/document-ast";

import { composeCourtListenerText } from "./compose";
import { createTextBudget, type FormatParse } from "./outcome";
import { paragraphsOf, parsePlainText, parsePreformatted } from "./plain-text";
import { recordedOpinionClusters } from "./test-oracle";

/** The raw text axis, before the shared projection folds spacing. */
const rawText = (block: Block): string =>
  "inlines" in block ? plainTextOf(block.inlines) : block.plainText;

const blocksOf = (parsed: FormatParse | null): Block[] => {
  if (parsed?.status !== "parsed") {
    throw new Error(`expected a parse, got ${parsed?.status ?? "none"}`);
  }
  return parsed.text.units.flatMap(({ blocks }) => [...blocks]);
};

const input = (text: string) => ({
  text,
  prefix: "o1",
  rowType: "020lead" as const,
  budget: createTextBudget(),
});

const composed = (clusterId: string) => {
  const opinions = recordedOpinionClusters().get(clusterId);
  if (opinions === undefined) {
    throw new Error(`no fixture for cluster ${clusterId}`);
  }
  return { opinions, outcome: composeCourtListenerText(opinions) };
};

describe("paragraphs of unmarked text", () => {
  test("opens a paragraph at a blank line in single-spaced text", () => {
    expect(paragraphsOf("One line\nwraps here.\n\nNext paragraph.")).toEqual([
      ["One line", "wraps here."],
      ["Next paragraph."],
    ]);
  });

  test("reads single blank lines of double-spaced text as spacing", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const text = `${lines.join("\n\n")}\n\n\nNew paragraph.`;
    expect(paragraphsOf(text)).toEqual([lines, ["New paragraph."]]);
  });

  test("opens a paragraph at a first-line indent, keeping continuation lines", () => {
    expect(
      paragraphsOf(
        "     First starts\nand continues.\n     Second starts\nand ends.",
      ),
    ).toEqual([
      ["     First starts", "and continues."],
      ["     Second starts", "and ends."],
    ]);
  });

  test("infers no heading from capitals and no page from a star", () => {
    const blocks = blocksOf(
      parsePlainText(
        input("OPINION AND ORDER\n\nSee id. at *3.\n\nIT IS SO ORDERED."),
      ),
    );
    expect(blocks.map(({ type }) => type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(blocks[1]?.plainText).toBe("See id. at *3.");
  });

  test("keeps the source's line breaks and indentation inside a paragraph", () => {
    const blocks = blocksOf(
      parsePlainText(
        input("  ERNEST CAREY,     )  Appeal\n  v.                )  No. 06"),
      ),
    );
    expect(
      blocks.map((block) => ("inlines" in block ? block.inlines : null)),
    ).toEqual([
      [
        { type: "text", text: "ERNEST CAREY,     )  Appeal" },
        { type: "line-break" },
        { type: "text", text: "  v.                )  No. 06" },
      ],
    ]);
  });

  test("reads a form feed as a page break and counts it as pagination", () => {
    const parsed = parsePlainText(input("end of page\fstart of next"));
    expect(blocksOf(parsed).map(({ plainText }) => plainText)).toEqual([
      "end of page",
      "start of next",
    ]);
    expect(
      parsed.status === "parsed"
        ? parsed.text.counts.paginationCharacters
        : null,
    ).toBe(1);
  });

  test("ends a paragraph at a page break, so a page's notes meet no body", () => {
    expect(
      paragraphsOf(
        "Body ends\n1 A note.\fBody resumes\nand ends.\n\n\fNew page.",
      ),
    ).toEqual([
      ["Body ends", "1 A note."],
      ["Body resumes", "and ends."],
      ["New page."],
    ]);
  });

  test("refuses blank text", () => {
    expect(parsePlainText(input(" \n\t "))).toEqual({
      status: "unusable",
      reason: "blank",
    });
  });
});

describe("preformatted bodies", () => {
  test("joins the text runs and the citation links between them", () => {
    const parsed = parsePreformatted(
      input(
        '<pre class="inline">See Werb v. D\'Alessandro, </pre><span class="citation" data-id="2383227"><a href="/opinion/2383227/werb/">606 A.2d 117, 119</a></span><pre class="inline"> (Del. 1992).</pre>',
      ),
    );
    expect(blocksOf(parsed).map(({ plainText }) => plainText)).toEqual([
      "See Werb v. D'Alessandro, 606 A.2d 117, 119 (Del. 1992).",
    ]);
    expect(
      parsed?.status === "parsed" ? parsed.text.counts.publisherLinks : null,
    ).toBe(1);
  });

  test("changing a citation link's target changes nothing parsed", () => {
    const body = (href: string, id: string) =>
      `<pre class="inline">Id., </pre><span class="citation" data-id="${id}"><a href="${href}">606 A.2d 117</a></span><pre class="inline">.</pre>`;
    expect(
      blocksOf(parsePreformatted(input(body("/opinion/1/a/", "1")))),
    ).toEqual(blocksOf(parsePreformatted(input(body("/opinion/9/z/", "9")))));
  });

  test("hands markup other than preformatted runs to the HTML parsers", () => {
    expect(
      parsePreformatted(input('<pre>a</pre><div class="x">b</div>')),
    ).toBeNull();
  });

  test("delegates a preformatted body with other markup to HTML", () => {
    expect(
      parsePreformatted(
        input('<pre class="inline">See the map.</pre><img src="map.png"/>'),
      ),
    ).toBeNull();
  });

  test("refuses a script-only body", () => {
    expect(
      parsePreformatted(
        input('<pre class="inline"></pre><script>x()</script>'),
      ),
    ).toEqual({
      status: "unusable",
      reason: "no-visible-text",
    });
  });
});

describe("recorded unmarked opinions", () => {
  // Opinion 4912325 (Delaware, combined row) was read by hand: a
  // double-spaced order in `<pre>` runs with two form feeds, one linked and
  // one unlinked citation, and four numbered paragraphs.
  test("parses the preformatted column of a combined row block by block", () => {
    const { outcome } = composed("5094940");
    expect(outcome.status).toBe("parsed");
    if (outcome.status !== "parsed") {
      return;
    }
    const [report] = outcome.opinions;
    expect(report).toMatchObject({
      format: "html_with_citations",
      structure: "pre",
      coverage: "block-only",
    });
    expect(report?.counts).toMatchObject({
      paginationCharacters: 2,
      publisherLinks: 1,
    });
    // Double-spaced: the single blank lines inside a numbered paragraph are
    // spacing, and its first-line indent is what opens it.
    const raw = outcome.blocks.map(rawText);
    expect(raw).toContain(
      [
        "(3)    The Clerk issued a notice directing Father to show cause why the appeal",
        "should not be dismissed for his failure to comply with Supreme Court Rule 42 in",
        "taking an appeal from an interlocutory order. On September 2, 2021, the Court",
        "received the certified mail receipt indicating that the notice to show cause had been",
        "delivered. A timely response to the notice to show cause would have been due on",
        "or before September 13, 2021. The appellant having failed to respond to the notice",
        "to show cause within the required ten-day period, dismissal of this action is deemed",
        "to be unopposed.",
      ].join("\n"),
    );
    expect(raw).toContain(
      "NOW, THEREFORE, IT IS ORDERED, under Supreme Court Rules 3(b)\nand 29(b), that the appeal is DISMISSED.",
    );
    expect(raw.join("\n")).toContain(
      "Hines v. Williams, 2018 WL 2435551 (Del. May 29, 2018).",
    );
    expect(outcome.blocks.every(({ type }) => type === "paragraph")).toBe(true);
    // A page break ends a paragraph: the page's last note and the next
    // page's first words are separate blocks, each scoped alone.
    expect(raw).toContain(
      "Hines v. Williams, 2018 WL 2435551 (Del. May 29, 2018).",
    );
    expect(raw).toContain(
      "rather than interlocutory, when it “leaves nothing for future determination or\nconsideration.”3",
    );
    expect(outcome.citationScopes).toEqual(
      outcome.blocks.map(({ id }, index) => ({
        opinionId: `cl-opinion:4912325/block-${index + 1}`,
        blockIds: [id],
        boundaries: "unproven",
      })),
    );
  });

  // Opinion 11209260 (South Carolina district court) is plain text only, a
  // single-spaced order whose paragraphs are not separated by blank lines.
  test("scopes a plain-text trial court document block by block", () => {
    const { outcome } = composed("10742675");
    expect(outcome.status).toBe("parsed");
    if (outcome.status !== "parsed") {
      return;
    }
    expect(outcome.opinions[0]).toMatchObject({
      format: "plain_text",
      structure: "plain",
      coverage: "block-only",
    });
    expect(outcome.citationScopes).toEqual(
      outcome.blocks.map(({ id }, index) => ({
        opinionId: `cl-opinion:11209260/block-${index + 1}`,
        blockIds: [id],
        boundaries: "unproven",
      })),
    );
    const texts = outcome.blocks.map(({ plainText }) => plainText);
    expect(texts[0]).toBe("IN THE DISTRICT COURT OF THE UNITED STATES");
    expect(texts.at(-1)).toStartWith(
      "* This motion invokes the Violent Crime Control",
    );
    // Neither the order's capitals nor its `*3` pin become structure.
    expect(outcome.blocks.every(({ type }) => type === "paragraph")).toBe(true);
    expect(outcome.opinions[0]?.counts?.pageAnchors).toBe(0);
    expect(texts.join("\n")).toContain("2025 WL 1852267, at *3");
    expect(
      outcome.blocks.every(
        (block) => block.type === "paragraph" && block.role === "unknown",
      ),
    ).toBe(true);
  });
});
