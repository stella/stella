import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";

import {
  locateAbbreviatedProvisionCitations,
  locateExternalCjeuCitations,
  locateStatuteCitations,
} from "@/features/case-law/fallback-legal-anchors";

const paragraph = (text: string): Block => ({
  anchorId: "p-1",
  id: "p-1",
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

const czech = PROVISION_CITATION_GRAMMARS.CZE;

describe("fallback legal citation anchors", () => {
  test("a gazette citation needs no provision locator and names its jurisdiction", () => {
    const text =
      "a na zrušení vyhlášky č. 485/2005 Sb., o rozsahu provozních údajů";
    const anchors = locateStatuteCitations([paragraph(text)]);

    expect(anchors).toHaveLength(1);
    const anchor = anchors.at(0);
    expect(text.slice(anchor?.start, anchor?.end)).toBe("č. 485/2005 Sb.");
    expect(anchor?.eli).toBe("https://www.e-sbirka.cz/eli/cz/sb/2005/485");
    expect(anchor?.jurisdiction).toBe("CZE");
  });

  test("a canonical statute abbreviation resolves every provision in its blocks", () => {
    const definition =
      "podle zákona č. 150/2002 Sb., soudní řád správní (dále jen „s. ř. s.“)";
    const firstUse = "návrh odmítl podle § 46 odst. 1 písm. a) s. ř. s.";
    const joinedUse = "rozhodl podle § 60 odst. 3 ve spojení s § 120 s. ř. s.";
    const citations = locateAbbreviatedProvisionCitations(
      [
        paragraph(definition),
        { ...paragraph(firstUse), anchorId: "p-2", id: "p-2" },
        { ...paragraph(joinedUse), anchorId: "p-3", id: "p-3" },
      ],
      czech,
    );

    expect(
      citations.map(({ abbreviation, anchor, blockId, end, start }) => ({
        anchor,
        blockId,
        eli: abbreviation.eli,
        text: [definition, firstUse, joinedUse]
          .at(Number(blockId.slice(2)) - 1)
          ?.slice(start, end),
      })),
    ).toEqual([
      {
        anchor: "par_46-odst_1-pism_a",
        blockId: "p-2",
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
        text: "§ 46 odst. 1 písm. a)",
      },
      {
        anchor: "par_60-odst_3",
        blockId: "p-3",
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
        text: "§ 60 odst. 3",
      },
      {
        anchor: "par_120",
        blockId: "p-3",
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
        text: "§ 120",
      },
    ]);
  });

  test("the span start is the document offset of the provision", () => {
    const first = "úvodní odstavec";
    const second = "podle § 46 odst. 1 s. ř. s.";
    const citations = locateAbbreviatedProvisionCitations(
      [paragraph(first), { ...paragraph(second), anchorId: "p-2", id: "p-2" }],
      czech,
    );

    expect(citations.map(({ spanStart }) => spanStart)).toEqual([
      first.length + 1 + second.indexOf("§"),
    ]);
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
});
