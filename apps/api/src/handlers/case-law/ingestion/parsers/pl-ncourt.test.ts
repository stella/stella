import { panic } from "better-result";
import { expect, test } from "bun:test";

import { parsePlDecisionContent, PL_DECISION_MARKUP } from "./pl-courts";
import { readPlNcourtContent } from "./pl-ncourt";

test.each([
  {
    name: "pl-ncourt-i-c-358-20",
    provisions: ["art. 505^9 k.p.c.", "art. 505^12 § 1^1"],
  },
  { name: "pl-ncourt-v-ca-1439-25", provisions: ["98 § 1^1 k.p.c."] },
])(
  "recorded portal XML keeps provision indices distinct: $name",
  async ({ name, provisions }) => {
    const xml = await Bun.file(
      new URL(`__fixtures__/${name}.xml`, import.meta.url),
    ).text();
    const content =
      readPlNcourtContent(xml) ?? panic("Fixture holds no court content");
    const { fulltext } = parsePlDecisionContent({
      caseNumber: "I C 1/20",
      ecli: undefined,
      court: "Sąd Rejonowy",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      documentUrl: undefined,
      content: content.html,
      keywords: [],
      statutes: [],
      documentId: name,
      superscripts: true,
      markup: PL_DECISION_MARKUP.COMMON_COURT,
    });

    expect(xml).toContain("<xSUPx>");
    for (const provision of provisions) {
      expect(fulltext).toContain(provision);
    }
  },
);
