import { expect, test } from "bun:test";

import { readPlNcourtContent } from "./pl-ncourt";
import { judgeLexLink } from "./pl-ncourt-lexlink";

const KPC_TITLE =
  "Ustawa z dnia 17 listopada 1964 r. - Kodeks postępowania cywilnego";

test("subdivisions stay under the article that prints them", () => {
  const anchor = "art. 1 § 2 oraz art. 2 § 1 k.p.c.";
  const verdict = (articles: string) =>
    judgeLexLink({ anchor, articles, title: KPC_TITLE }).type;
  expect(verdict("art. 1;art. 1 § 2")).toBe("provision");
  expect(verdict("art. 2;art. 2 § 1")).toBe("provision");
  expect(verdict("art. 1;art. 1 § 1")).toBe("act");
  expect(verdict("art. 2;art. 2 § 2")).toBe("act");
});

const document = (links: string[]): string =>
  `<xPart><xText>${links.join(" ")}</xText></xPart>`;

const kpcLink = (articles: string, anchor: string): string =>
  `<xLexLink xArt="${articles}" xIsapId="WDU19640430296" xTitle="${KPC_TITLE}">${anchor}</xLexLink>`;

test("an unsupported occurrence does not hide a supported one with the same attributes", () => {
  const supported = kpcLink("art. 98;art. 98 § 1", "art. 98 § 1 k.p.c.");
  const unsupported = kpcLink("art. 98;art. 98 § 1", "art. 98 § 2 k.p.c.");
  for (const links of [
    [unsupported, supported],
    [supported, unsupported],
  ]) {
    const content = readPlNcourtContent(document(links));
    expect(
      content?.legalReferences
        .map((reference) => reference.articles)
        .toSorted(),
    ).toEqual(["", "art. 98;art. 98 § 1"]);
    expect(content?.rejectedLegalReferences).toHaveLength(1);
  }
});

test("identical occurrences are recorded once", () => {
  const link = kpcLink("art. 98;art. 98 § 1", "art. 98 § 1 k.p.c.");
  const content = readPlNcourtContent(document([link, link]));
  expect(content?.legalReferences).toHaveLength(1);
});
