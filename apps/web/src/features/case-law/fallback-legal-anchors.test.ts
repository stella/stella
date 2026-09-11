import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  locateCzechStatuteCitations,
  locateExternalCjeuCitations,
} from "@/features/case-law/fallback-legal-anchors";

const paragraph = (text: string): Block => ({
  anchorId: "p-1",
  id: "p-1",
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

describe("fallback legal citation anchors", () => {
  test("a Czech statute citation needs no provision locator", () => {
    const text =
      "a na zrušení vyhlášky č. 485/2005 Sb., o rozsahu provozních údajů";
    const anchors = locateCzechStatuteCitations([paragraph(text)]);

    expect(anchors).toHaveLength(1);
    const anchor = anchors.at(0);
    expect(text.slice(anchor?.start, anchor?.end)).toBe("č. 485/2005 Sb.");
    expect(anchor?.eli).toBe("https://www.e-sbirka.cz/eli/cz/sb/2005/485");
  });

  test("every member of a joined CJEU citation gets its own official link", () => {
    const text =
      "Volker und Markus Schecke a Hartmut Eifert (C-92/09 a C-93/09)";
    const anchors = locateExternalCjeuCitations([paragraph(text)]);

    expect(
      anchors.map((anchor) => text.slice(anchor.start, anchor.end)),
    ).toEqual(["C-92/09", "C-93/09"]);
    expect(anchors.map((anchor) => anchor.href)).toEqual([
      "https://curia.europa.eu/juris/liste.jsf?num=C-92%2F09",
      "https://curia.europa.eu/juris/liste.jsf?num=C-93%2F09",
    ]);
  });

  test("case-law reporters and the treaty collection are not statutes", () => {
    const anchors = locateCzechStatuteCitations([
      paragraph("č. 12/2020 Sb. NSS; 67/2013 Sb. m. s."),
    ]);

    expect(anchors).toEqual([]);
  });
});
