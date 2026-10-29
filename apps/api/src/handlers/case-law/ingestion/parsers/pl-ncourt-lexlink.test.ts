import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { readPlNcourtContent } from "./pl-ncourt";
import {
  judgeLexLink,
  LEXLINK_REJECTION,
  type LexLinkVerdict,
} from "./pl-ncourt-lexlink";

const KPC_TITLE =
  "Ustawa z dnia 17 listopada 1964 r. - Kodeks postępowania cywilnego";

const fixture = async (name: string) =>
  await Bun.file(new URL(`__fixtures__/${name}`, import.meta.url)).text();

const anchorsOf = (
  html: string,
): { href: string | undefined; text: string }[] =>
  [...html.matchAll(/<a(?: href="([^"]*)")?>(.*?)<\/a>/gsu)].map(
    ([, href, inner]) => ({
      href,
      text: (inner ?? "").replaceAll(/<[^>]+>/gu, "").replaceAll(/\s+/gu, " "),
    }),
  );

const KPC_ROOT = "https://isap.sejm.gov.pl/DetailsServlet?id=WDU19640430296";

test("a paragraph of a regulation is not kept as a code article", async () => {
  const content = readPlNcourtContent(
    await fixture("pl-ncourt-lexlinks-v-ca-1439-25.xml"),
  );
  expect(content).not.toBeNull();
  expect(content?.html).toContain("§ 10 ust. 1 pkt. 1 w zw. z § 2 pkt 3");
  expect(anchorsOf(content?.html ?? "").map(({ text }) => text)).not.toContain(
    "§ 10 ust. 1 pkt. 1",
  );
  expect(content?.rejectedLegalReferences).toEqual([
    {
      text: "§ 10 ust. 1 pkt. 1",
      articles: "art. 98 § 10;art. 98 § 10 ust. 1;art. 98 § 10 ust. 1 pkt. 1",
      isapId: "WDU19640430296",
      reason: LEXLINK_REJECTION.BARE_PROVISION,
      outcome: "link-dropped",
    },
    {
      text: "§ 1(1) k.p.c.",
      articles: "§ 1(1)",
      isapId: "WDU19640430296",
      reason: LEXLINK_REJECTION.BARE_PROVISION,
      outcome: "link-dropped",
    },
  ]);
});

test("superscripted articles keep the provisions the publisher tagged", async () => {
  const content = readPlNcourtContent(
    await fixture("pl-ncourt-lexlinks-v-ca-1439-25.xml"),
  );
  const articles = content?.legalReferences.map(
    (reference) => reference.articles,
  );
  expect(articles).toContain("art. 505(8);art. 505(8) § 4");
  expect(articles).toContain("art. 505(1)");
  expect(articles).toContain("art. 505(13)");
  expect(articles).not.toContain("§ 1(1)");
  expect(
    content?.legalReferences.some((reference) =>
      reference.articles.includes("§ 10"),
    ),
  ).toBe(false);
});

test("an index the publisher flattened into a second article loses its provisions", async () => {
  const content = readPlNcourtContent(
    await fixture("pl-ncourt-lexlinks-iii-ca-1284-16-reasons.xml"),
  );
  const articles = content?.legalReferences.map(
    (reference) => reference.articles,
  );
  for (const article of ["art. 1", "art. 9", "art. 12", "art. 13", "art. 14"]) {
    expect(articles?.some((entry) => entry.split(";").includes(article))).toBe(
      false,
    );
  }
  expect(content?.rejectedLegalReferences).toEqual(
    [
      { text: "art. 505 1 k.p.c.", articles: "art. 505;art. 1" },
      { text: "art. 505 14 k.p.c.", articles: "art. 505;art. 14" },
      {
        text: "art. 505 9 § 1 1 k.p.c.",
        articles: "art. 505;art. 9;art. 9 § 1;art. 9 § 1",
      },
      {
        text: "art. 505 13 § 2 k.p.c.",
        articles: "art. 505;art. 13;art. 13 § 2",
      },
      {
        text: "art. 505 12 § 3 k.p.c.",
        articles: "art. 505;art. 12;art. 12 § 3",
      },
    ].map(({ text, articles: claimed }) => ({
      text,
      articles: claimed,
      isapId: "WDU19640430296",
      reason: LEXLINK_REJECTION.PROVISION_NOT_IN_ANCHOR,
      outcome: "provision-dropped",
    })),
  );
  // The act link stays on the words; none of the words is lost.
  const flattened = anchorsOf(content?.html ?? "").filter(({ text }) =>
    text.startsWith("art. 505 "),
  );
  expect(flattened).toHaveLength(5);
  expect(flattened.every(({ href }) => href === KPC_ROOT)).toBe(true);
});

test("a link whose anchor prints its provisions is kept as published", async () => {
  const content = readPlNcourtContent(
    await fixture("pl-ncourt-lexlinks-iii-ca-1284-16-reasons.xml"),
  );
  const articles = content?.legalReferences.map(
    (reference) => reference.articles,
  );
  expect(articles).toContain("art. 233;art. 233 § 1");
  expect(articles).toContain("art. 328;art. 328 § 2");
  expect(articles).toContain("art. 385");
  expect(articles).toContain("");
});

const KNOWN: [string, string, LexLinkVerdict["type"]][] = [
  ["art. 233 § 1 k.p.c.", "art. 233;art. 233 § 1", "provision"],
  ["art.233 § 1 kpc", "art. 233;art. 233 § 1", "provision"],
  ["art. 233 § 1 in fine k.p.c.", "art. 233;art. 233 § 1", "provision"],
  ["art. 98 § 1 k. p. c.", "art. 98;art. 98 § 1", "provision"],
  [
    "art. 233 § 1 i 2 k.p.c.",
    "art. 233;art. 233 § 1;art. 233 § 2",
    "provision",
  ],
  ["Kodeksu postępowania cywilnego", "", "act"],
  ["art. 98 k.p.c.", "art. 98 § 10", "act"],
  ["§ 2 pkt 3", "art. 98 § 2", "rejected"],
  ["§ 2 pkt 3 rozporządzenia Ministra Sprawiedliwości", "", "rejected"],
  ["art. 3 dyrektywy 2000/31/WE", "art. 3", "rejected"],
  // Letter subdivisions are letters, listed with the same joiners as numbers.
  [
    "art. 6 ust. 1 lit. a k.p.c.",
    "art. 6;art. 6 ust. 1;art. 6 ust. 1 lit. a",
    "provision",
  ],
  [
    "art. 6 ust. 1 lit. a i b k.p.c.",
    "art. 6;art. 6 ust. 1;art. 6 ust. 1 lit. a;art. 6 ust. 1 lit. b",
    "provision",
  ],
  ["art. 6 ust. 1 lit. a k.p.c.", "art. 6;art. 6 ust. 1 lit. b", "act"],
];

test.each(KNOWN)("judges %p against %p as %p", (anchor, articles, type) => {
  expect(judgeLexLink({ anchor, articles, title: KPC_TITLE }).type).toBe(type);
});

test("a regulation tagged as itself may name regulations", () => {
  expect(
    judgeLexLink({
      anchor: "§ 2 rozporządzenia",
      articles: "",
      title: "Rozporządzenie Ministra Sprawiedliwości",
    }).type,
  ).toBe("rejected");
  expect(
    judgeLexLink({
      anchor: "art. 3 rozporządzenia",
      articles: "art. 3",
      title: "Rozporządzenie Ministra Sprawiedliwości",
    }).type,
  ).toBe("provision");
});

const level = fc.integer({ min: 1, max: 400 });
const chain = fc.record({
  article: level,
  index: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
  paragraph: fc.option(level, { nil: undefined }),
  clause: fc.option(level, { nil: undefined }),
  point: fc.option(level, { nil: undefined }),
});
type Chain = typeof chain extends fc.Arbitrary<infer Value> ? Value : never;

const labelled = ({ article, index, paragraph, clause, point }: Chain) => {
  const levels = [
    `art. ${article}${index === undefined ? "" : `(${index})`}`,
    ...(paragraph === undefined ? [] : [`§ ${paragraph}`]),
    ...(paragraph === undefined || clause === undefined
      ? []
      : [`ust. ${clause}`]),
    ...(paragraph === undefined || clause === undefined || point === undefined
      ? []
      : [`pkt. ${point}`]),
  ];
  return levels.map((_, end) => levels.slice(0, end + 1).join(" "));
};

const claimOf = (value: Chain): string => labelled(value).join(";");
const anchorOf = (value: Chain): string =>
  `${labelled(value).at(-1) ?? panic("A chain has at least an article")} k.p.c.`.replace(
    /\((\d+)\)/u,
    " ($1)",
  );

test(
  "a claim built from the anchor's own provisions is kept",
  () => {
    assertProperty(
      "a claim built from the anchor's own provisions is kept",
      fc.property(chain, (value) => {
        const verdict = judgeLexLink({
          anchor: anchorOf(value),
          articles: claimOf(value),
          title: KPC_TITLE,
        });
        expect(verdict.type).toBe("provision");
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "a claim naming a provision the anchor does not print is never kept",
  () => {
    assertProperty(
      "a claim naming a provision the anchor does not print is never kept",
      fc.property(chain, level, (value, other) => {
        fc.pre(other !== value.article);
        const verdict = judgeLexLink({
          anchor: anchorOf(value),
          articles: `${claimOf(value)};art. ${other}`,
          title: KPC_TITLE,
        });
        expect(verdict.type).not.toBe("provision");
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "an anchor naming another act never points at the tagged act",
  () => {
    assertProperty(
      "an anchor naming another act never points at the tagged act",
      fc.property(
        chain,
        fc.constantFrom(
          "rozporządzenia Ministra Sprawiedliwości",
          "rozporządzeniu",
          "dyrektywy 2000/31/WE",
          "konwencji",
        ),
        fc.boolean(),
        (value, act, withClaim) => {
          const verdict = judgeLexLink({
            anchor: `${labelled(value).at(-1)} ${act}`,
            articles: withClaim ? claimOf(value) : "",
            title: KPC_TITLE,
          });
          expect(verdict.type).toBe("rejected");
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "an anchor with a paragraph but no article never points at an act",
  () => {
    assertProperty(
      "an anchor with a paragraph but no article never points at an act",
      fc.property(
        level,
        level,
        fc.string({ maxLength: 40 }),
        (paragraph, article, claim) => {
          const verdict = judgeLexLink({
            anchor: `§ ${paragraph} k.p.c.`,
            articles: `art. ${article} § ${paragraph};${claim}`,
            title: KPC_TITLE,
          });
          expect(verdict.type).toBe("rejected");
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);
