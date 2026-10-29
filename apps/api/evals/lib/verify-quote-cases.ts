import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

const fixtureSchema = v.object({
  decisions: v.array(
    v.object({
      case_number: v.string(),
      court: v.string(),
      fulltext: v.nullable(v.string()),
      source_url: v.nullable(v.string()),
    }),
  ),
});

export const publicQuoteDecisions = () => [
  ...["cz-nss", "cz-us", "cz-ns", "cz-regional"].map((court) => {
    const data: unknown = JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(
            `../../scripts/__fixtures__/case-law/${court}.json.gz`,
            import.meta.url,
          ),
        ),
      ).toString(),
    );
    const decisions = v.parse(fixtureSchema, data).decisions;
    const decision =
      decisions
        .toSorted(
          (left, right) =>
            (right.fulltext?.length ?? 0) - (left.fulltext?.length ?? 0),
        )
        .at(0) ?? panic("Public quote fixture holds a decision");
    return {
      ...decision,
      fulltext:
        decision.fulltext ?? panic("Public quote fixture has stored text"),
    };
  }),
  {
    case_number: "64 A 3/2025-89",
    court: "Krajský soud v Brně",
    source_url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/743299",
    fulltext: gunzipSync(
      readFileSync(
        new URL(
          "../../src/mcp/__fixtures__/cz-ksbr-64-a-3-2025.txt.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  },
];

export const publicQuoteCases = (text: string, otherText: string) => {
  const paragraphs = text
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 200 && line.length < 650 && !/…|\.{3}/u.test(line),
    );
  const paragraph =
    paragraphs.at(Math.floor(paragraphs.length / 2)) ??
    panic("Public fixture has a bounded substantive paragraph");
  const words = paragraph.split(/\s+/u);
  const other =
    otherText
      .split(/\n+/u)
      .find(
        (line) =>
          line.length > 200 && line.length < 650 && !/…|\.{3}/u.test(line),
      ) ?? panic("Other decision has a passage");
  const firstParagraph = paragraphs.at(0) ?? panic("Public paragraph exists");
  const firstStart = text.indexOf(firstParagraph);
  const following = /\S/u.exec(text.slice(firstStart + firstParagraph.length));
  const spanEnd =
    following === null
      ? firstStart + firstParagraph.length
      : firstStart + firstParagraph.length + following.index + 60;
  const paragraphSpan = text.slice(
    firstStart + firstParagraph.length - 60,
    spanEnd,
  );
  return [
    { name: "paragraph_span", quote: paragraphSpan, expected: "exact" },
    { name: "exact", quote: paragraph, expected: "exact" },
    {
      name: "typography",
      quote: paragraph
        .replaceAll(" ", "\u00a0")
        .replaceAll("„", '"')
        .replaceAll("“", '"')
        .replaceAll("–", "-"),
      expected: "exact",
    },
    {
      name: "altered_word",
      quote: words
        .map((word, index) => {
          if (index !== 6) {
            return word;
          }
          return word === "přezkoumal" ? "odmítl" : "přezkoumal";
        })
        .join(" "),
      expected: "fuzzy",
    },
    {
      name: "dropped_clause",
      quote: words.filter((_, index) => index < 7 || index > 10).join(" "),
      expected: "fuzzy",
    },
    {
      name: "truncated",
      quote: words.slice(0, -5).join(" "),
      expected: "exact",
    },
    {
      name: "ellipsis",
      quote: `${words.slice(0, 6).join(" ")} […] ${words.slice(-6).join(" ")}`,
      expected: "exact",
    },
    { name: "different_decision", quote: other, expected: "not_found" },
    {
      name: "fabricated",
      quote:
        "Soud jednomyslně dovodil, že automatizovaná analýza všech digitálních podkladů zakládá nevyvratitelnou domněnku oprávněnosti žalobního nároku bez dalšího dokazování.",
      expected: "not_found",
    },
  ] as const;
};

export const largePublicQuoteDecision = () =>
  gunzipSync(
    readFileSync(
      new URL(
        "../../src/mcp/__fixtures__/cz-us-pl-19-08.txt.gz",
        import.meta.url,
      ),
    ),
  ).toString();
