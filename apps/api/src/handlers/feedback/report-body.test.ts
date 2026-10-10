import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { FEEDBACK_AREAS, FEEDBACK_KINDS } from "@stll/api-contract/feedback";
import type { FeedbackReportInput } from "@stll/api-contract/feedback";
import { assertProperty } from "@stll/property-testing";

import {
  composeGithubIssueBody,
  composeGithubIssueTitle,
} from "@/api/handlers/feedback/report-body";
import {
  markdownLines,
  readCodeSpans,
  readFencedBlockAt,
} from "@/api/tests/helpers/commonmark-code-oracle";

const LINE_BREAK = /\r\n|\r|\n/gu;

/**
 * What GitHub could act on in text it renders: a mention, an issue or commit
 * reference, an entity, raw HTML, a backtick, or a link. Only the body's own
 * `## ` headings and `- Label:` lines may sit outside code.
 */
const LIVE_OUTSIDE_CODE = /[@#&<>`[\]]|gh-[0-9]|https?:/iu;
const HEADING_MARK = /^## /u;

type BodyReading = { blocks: string[]; spans: string[]; outside: string[] };

/** Walks the body the way CommonMark does for the constructs it uses. */
const readBody = (markdown: string): BodyReading => {
  const lines = markdownLines(markdown);
  const reading: BodyReading = { blocks: [], spans: [], outside: [] };
  let index = 0;
  while (index < lines.length) {
    const block = readFencedBlockAt(lines, index);
    if (block !== undefined) {
      // A block must start a fresh paragraph at the top level.
      expect(lines[index - 1]).toBe("");
      expect(block.closeIndex).toBeDefined();
      reading.blocks.push(block.content);
      index = (block.closeIndex ?? lines.length) + 1;
      continue;
    }
    const inline = readCodeSpans(lines[index] ?? "");
    reading.spans.push(...inline.spans);
    reading.outside.push(inline.outside.replace(HEADING_MARK, ""));
    index += 1;
  }
  return reading;
};

const hostileText = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "```",
        "````",
        "\n```\n",
        "\r\n   ````  ",
        "`",
        "\n",
        "\r\n",
        "\r",
        "@octocat",
        "#7",
        "GH-7",
        "&#64;octocat",
        "<!--",
        "</details>",
        "## Context",
        "---",
        "https://github.com/stella/stella/pull/2",
      ),
      fc.string({ maxLength: 3 }),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((pieces) => pieces.join(""));

const report = fc.record(
  {
    kind: fc.constantFrom(...FEEDBACK_KINDS),
    area: fc.constantFrom(...FEEDBACK_AREAS),
    title: hostileText,
    whatHappened: hostileText,
    expected: hostileText,
    steps: hostileText,
    evidence: hostileText,
    context: fc.record(
      {
        clientVersion: hostileText,
        requestId: fc.constantFrom("req-1", "abc.DEF_2"),
        route: hostileText,
        errorReference: hostileText,
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: ["kind", "area", "title", "whatHappened"] },
);

const present = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

describe("issue body", () => {
  test("reporter text renders only as code, verbatim and in order", () => {
    assertProperty(
      "reporter text renders only as code, verbatim and in order",
      fc.property(report, (input: FeedbackReportInput) => {
        const body = composeGithubIssueBody({
          receipt: "FB-7K2M-9QXA",
          serverVersion: "1.2.3",
          report: input,
        }).markdown;
        const reading = readBody(body);

        expect(reading.blocks).toEqual(
          [input.whatHappened, input.expected, input.steps, input.evidence]
            .filter(present)
            .map((text) => text.replaceAll(LINE_BREAK, "\n")),
        );
        const context = input.context ?? {};
        expect(reading.spans).toEqual(
          [
            input.kind,
            input.area,
            "FB-7K2M-9QXA",
            "1.2.3",
            context.clientVersion,
            context.requestId,
            context.route,
            context.errorReference,
          ]
            .filter((value) => value !== undefined)
            .map((value) => value.replaceAll(LINE_BREAK, " "))
            .map((value) => (/^ *$/u.test(value) ? ` ${value} ` : value)),
        );
        for (const line of reading.outside) {
          expect(line).not.toMatch(LIVE_OUTSIDE_CODE);
        }
      }),
    );
  });

  test("an entity-spelled mention and a longer fence stay inside the block", () => {
    const body = composeGithubIssueBody({
      receipt: "FB-7K2M-9QXA",
      serverVersion: "1.2.3",
      report: {
        kind: "bug",
        area: "templates",
        title: "unused here",
        whatHappened: "````\ncc &#64;octocat <!-- see #42\n````",
        context: { route: "/x/@y/#1" },
      },
    }).markdown;
    const reading = readBody(body);
    expect(reading.blocks).toEqual([
      "````\ncc &#64;octocat <!-- see #42\n````",
    ]);
    expect(reading.spans).toContain("/x/@y/#1");
    expect(reading.outside.join("\n")).not.toMatch(LIVE_OUTSIDE_CODE);
  });
});

describe("issue title", () => {
  test("carries no live mention or reference", () => {
    expect(
      composeGithubIssueTitle({
        kind: "bug",
        area: "templates",
        title: "cc @octocat about #12",
        whatHappened: "x",
      }).text,
    ).toBe("cc @\u200Boctocat about #\u200B12");
  });
});
