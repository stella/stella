import { describe, expect, test } from "bun:test";

import type { Decision } from "./case-law";
import { decisionPage, isWebUrl } from "./decision-page";

const LABELS = {
  headnote: "Headnote",
  openSource: "Open the source",
  textUnavailable: "No text",
};

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: "d1",
  caseNumber: "I. ÚS 1/20",
  court: "Ústavní soud",
  ecli: "ECLI:CZ:US:2020:1.US.1.20.1",
  decisionDate: "2020-05-04",
  decisionType: "Nález",
  headnote: "The court annuls.",
  blocks: null,
  fulltext: "First\n\nSecond",
  sourceUrl: "https://nalus.usoud.cz/Search/ResultDetail.aspx?id=1",
  webPath: "/law/cz/us/i-us-1-20",
  ...overrides,
});

describe("decisionPage", () => {
  test("names the decision, its headnote, text and source as plain data", () => {
    const page = decisionPage({
      decision: decision(),
      decided: "4 May 2020",
      labels: LABELS,
    });
    expect(page).toEqual({
      caseNumber: "I. ÚS 1/20",
      details: ["Ústavní soud", "Nález", "4 May 2020"],
      ecli: "ECLI:CZ:US:2020:1.US.1.20.1",
      headnote: { label: "Headnote", text: "The court annuls." },
      blocks: [
        {
          kind: "paragraph",
          id: "0",
          number: null,
          depth: 0,
          quote: false,
          runs: [
            {
              id: "0",
              text: "First",
              strong: false,
              emphasis: false,
              href: null,
            },
          ],
        },
        {
          kind: "paragraph",
          id: "1",
          number: null,
          depth: 0,
          quote: false,
          runs: [
            {
              id: "0",
              text: "Second",
              strong: false,
              emphasis: false,
              href: null,
            },
          ],
        },
      ],
      unavailable: "No text",
      source: {
        label: "Open the source",
        href: "https://nalus.usoud.cz/Search/ResultDetail.aspx?id=1",
      },
    });
  });

  test("leaves out the details, headnote and source a decision lacks", () => {
    const page = decisionPage({
      decision: decision({
        decisionType: "",
        ecli: null,
        headnote: null,
        fulltext: null,
        sourceUrl: "ftp://nalus.usoud.cz/1",
      }),
      decided: null,
      labels: LABELS,
    });
    expect(page.details).toEqual(["Ústavní soud"]);
    expect(page.ecli).toBeNull();
    expect(page.headnote).toBeNull();
    expect(page.blocks).toEqual([]);
    expect(page.source).toBeNull();
  });

  test("keeps links in structured text to the decision's publisher alone", () => {
    const link = (href: string, words: string) => ({
      type: "link",
      href,
      children: [{ type: "text", text: words }],
    });
    const page = decisionPage({
      decision: decision({
        blocks: [
          {
            id: "p",
            type: "paragraph",
            inlines: [
              link("https://nalus.usoud.cz/x", "nález"),
              { type: "text", text: " and " },
              link("https://database.example/y", "statute"),
            ],
          },
        ],
      }),
      decided: null,
      labels: LABELS,
    });
    const [block] = page.blocks;
    expect(
      block?.kind === "paragraph"
        ? block.runs.map((run) => [run.text, run.href])
        : null,
    ).toEqual([
      ["nález", "https://nalus.usoud.cz/x"],
      [" and statute", null],
    ]);
  });
});

test("isWebUrl accepts http(s) addresses alone", () => {
  expect(isWebUrl(" HTTPS://usoud.cz ")).toBe(true);
  expect(isWebUrl("http://usoud.cz")).toBe(true);
  expect(isWebUrl("mailto:a@usoud.cz")).toBe(false);
  expect(isWebUrl("ftp://usoud.cz")).toBe(false);
  expect(isWebUrl("https://")).toBe(false);
});
