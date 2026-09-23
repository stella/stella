import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  InlineContent,
  inlinesToPlainText,
} from "@/components/legal-reader/document-ast-text";
import {
  readerHref,
  SourceLinkPolicyProvider,
  sourceLinkPolicyOf,
} from "@/components/legal-reader/source-link-policy";

/**
 * A court's own document is typeset with links into whichever legal database
 * its publisher uses, for every statute the decision cites. The reader renders
 * the publisher's own links and nothing else: a reference whose vendor link is
 * withheld is the one our statute pages answer, and one the corpus does not
 * hold reads as plain text.
 *
 * The hosts below are neutral examples, not any real publisher or vendor.
 */

const PUBLISHER = "https://courts.example.gov/decisions/1";
const VENDOR = "https://statutes.example.com/act/150-2002";

/** The shape a source AST carries a vendor link in: a `citation` node. */
const citedStatute = (href: string): Inline => ({
  children: [{ text: "§ 46 s. ř. s.", type: "text" }],
  cite: "§ 46 s. ř. s.",
  href,
  type: "citation",
});

const paragraph = (inlines: Inline[]): Block => ({
  anchorId: "par_1",
  id: "b1",
  inlines,
  plainText: inlinesToPlainText(inlines),
  type: "paragraph",
});

const renderBlock = (inlines: Inline[], urls: (string | null)[]) =>
  renderToStaticMarkup(
    <SourceLinkPolicyProvider urls={urls}>
      <BlockRenderer
        activeMatchIndex={-1}
        // Embedded: a document-addressable block draws a permalink, which
        // needs the reader's translations and says nothing about link policy.
        anchorPresentation="embedded"
        block={paragraph(inlines)}
        rangesByPieceId={{}}
        variant="case-law"
      />
    </SourceLinkPolicyProvider>,
  );

describe("hyperlinks a source document carries", () => {
  test("a link to an outside legal database renders without the link", () => {
    const html = renderBlock([citedStatute(VENDOR)], [PUBLISHER]);

    expect(html).not.toContain("statutes.example.com");
    expect(html).not.toContain("<a");
    // The words stay, and `data-cite` stays with them, so the citator can
    // still lay our own statute link over the same span.
    expect(html).toContain("§ 46 s. ř. s.");
    expect(html).toContain('data-cite="§ 46 s. ř. s."');
  });

  test("the decision's own publisher keeps its links", () => {
    const html = renderBlock(
      [
        {
          children: [{ text: "the ruling under review", type: "text" }],
          href: PUBLISHER,
          type: "link",
        },
      ],
      [PUBLISHER],
    );

    expect(html).toContain(`href="${PUBLISHER}"`);
  });

  test("a publisher's sibling host counts as the publisher", () => {
    const policy = sourceLinkPolicyOf(["https://search.example.gov/x"]);

    expect(readerHref("https://example.gov/act", policy)).toBe(
      "https://example.gov/act",
    );
    expect(readerHref("https://files.search.example.gov/a", policy)).toBe(
      "https://files.search.example.gov/a",
    );
    // A different registrable domain is a different publisher, whatever the
    // suffix it shares.
    expect(readerHref("https://example.com/act", policy)).toBeUndefined();
  });

  test("in-document and in-app targets are never external", () => {
    const policy = sourceLinkPolicyOf([]);

    expect(readerHref("#par_2", policy)).toBe("#par_2");
    expect(readerHref("/law/cze/statutes/x", policy)).toBe(
      "/law/cze/statutes/x",
    );
    // A protocol `sanitizeHref` rejects stays rejected here.
    expect(readerHref("data:text/html,<p>x</p>", policy)).toBeUndefined();
    // A scheme-relative URL is not the in-app path its slash suggests.
    expect(readerHref("//example.com/act", policy)).toBeUndefined();
    // No exception for a mail link either: it has no host to be published at.
    expect(readerHref("mailto:clerk@example.gov", policy)).toBeUndefined();
  });

  test("a reader that names no publisher renders no outside link", () => {
    // The context default: a reader mounted without the provider degrades a
    // link to its words rather than leaking it.
    const html = renderToStaticMarkup(
      <InlineContent
        activeMatchIndex={-1}
        inlines={[citedStatute(VENDOR)]}
        pieceId="p"
        ranges={[]}
      />,
    );

    expect(html).not.toContain("<a");
    expect(html).toContain("§ 46 s. ř. s.");
  });

  test("an excerpt keeps a footnote reference's words without its jump", () => {
    const footnoteRef: Inline = {
      children: [{ text: "2)", type: "text" }],
      href: "#ppc_2",
      type: "link",
    };
    const render = (anchorPresentation: "document" | "embedded") =>
      renderToStaticMarkup(
        <InlineContent
          activeMatchIndex={-1}
          anchorPresentation={anchorPresentation}
          inlines={[footnoteRef]}
          pieceId="p"
          ranges={[]}
        />,
      );

    expect(render("document")).toContain('href="#ppc_2"');
    // An excerpt carries no `ppc_2`, and the page around it may.
    const embedded = render("embedded");
    expect(embedded).not.toContain("<a");
    expect(embedded).toContain("2)");
  });

  test("a bare vendor URL printed in the text is not auto-linked", () => {
    // `bareUrlAnchors` manufactures a link the source never marked up, so it
    // answers to the same policy.
    const html = renderBlock(
      [{ text: `viz ${VENDOR} a dále`, type: "text" }],
      [PUBLISHER],
    );

    expect(html).not.toContain("<a");
    expect(html).toContain(VENDOR);
  });
});
