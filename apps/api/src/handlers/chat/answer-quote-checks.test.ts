import { describe, expect, it } from "bun:test";

import { TimeoutError } from "@stll/concurrency/with-timeout";
import { answerQuoteKey } from "@stll/legal-ast/answer-quote";
import type { Block } from "@stll/legal-ast/document-ast";

import { checkAnswerQuotes } from "@/api/handlers/chat/answer-quote-checks";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { DecisionBlocksByDecision } from "@/api/lib/case-law/court-paragraph-numbers";

const COURT_TEXT =
  "Je-li dovolání podáno někým, kdo k dovolání není oprávněn, dovolací soud jej odmítne.";
const OTHER_TEXT =
  "Obecným pravidlem je ale rozhodování senátní, rozhodování samosoudcovské představuje výjimku.";

const FIRST = toSafeId<"caseLawDecision">(
  "0191a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
);
const SECOND = toSafeId<"caseLawDecision">(
  "0191a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6c",
);

const paragraph = (anchorId: string, number: number, text: string) =>
  ({
    anchorId,
    id: anchorId,
    inlines: [{ text, type: "text" }],
    number,
    plainText: text,
    type: "paragraph",
  }) satisfies Block;

const DECISIONS: DecisionBlocksByDecision = new Map([
  [FIRST, [paragraph("p-28", 16, COURT_TEXT)]],
  [SECOND, [paragraph("p-4", 2, OTHER_TEXT)]],
]);

const answer = (...contents: string[]) => ({
  parts: contents.map((content): ChatPart => ({ type: "text", content })),
});

type Load = Parameters<typeof checkAnswerQuotes>[0]["load"];

const recordingLoad = (decisions: DecisionBlocksByDecision) => {
  const requested: string[][] = [];
  const load: Load = async (decisionIds) => {
    requested.push([...decisionIds]);
    return await Promise.resolve(
      new Map([...decisions].filter(([id]) => decisionIds.includes(id))),
    );
  };
  return { load, requested };
};

describe("checkAnswerQuotes", () => {
  it("verifies a quotation a cited decision holds, at its paragraph", async () => {
    const { load, requested } = recordingLoad(DECISIONS);
    const checks = await checkAnswerQuotes({
      message: answer(
        `Podle [soudu](#stella-decision-passage=${FIRST}:p-28):\n\n> „${COURT_TEXT}“`,
      ),
      load,
    });

    expect(requested).toEqual([[FIRST]]);
    expect(checks).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(COURT_TEXT),
          decisionId: FIRST,
          anchorId: "p-28",
          paragraph: 16,
        },
      ],
    });
  });

  it("reads decisions linked by id and quotations across every text part", async () => {
    const { load } = recordingLoad(DECISIONS);
    const checks = await checkAnswerQuotes({
      message: answer(
        `Viz [rozhodnutí](#stella-decision=${SECOND}).`,
        `> ${OTHER_TEXT}`,
      ),
      load,
    });

    expect(checks).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(OTHER_TEXT),
          decisionId: SECOND,
          anchorId: "p-4",
          paragraph: 2,
        },
      ],
    });
  });

  it("marks a misquote unverified once every cited decision was read", async () => {
    const misquote = COURT_TEXT.replace("odmítne", "zamítne");
    const { load } = recordingLoad(DECISIONS);
    const checks = await checkAnswerQuotes({
      message: answer(
        `[1](#stella-decision-passage=${FIRST}:p-28)\n\n> ${misquote}`,
      ),
      load,
    });

    expect(checks).toEqual({
      type: "checked",
      checks: [{ type: "unverified", key: answerQuoteKey(misquote) }],
    });
  });

  it("leaves a quotation unchecked when a cited decision could not be read", async () => {
    const misquote = COURT_TEXT.replace("odmítne", "zamítne");
    const { load } = recordingLoad(new Map([...DECISIONS].slice(0, 1)));
    const checks = await checkAnswerQuotes({
      message: answer(
        `[1](#stella-decision=${FIRST}) [2](#stella-decision=${SECOND})\n\n> ${misquote}`,
      ),
      load,
    });

    expect(checks).toEqual({
      type: "checked",
      checks: [{ type: "unchecked", key: answerQuoteKey(misquote) }],
    });
  });

  it("leaves quotations unchecked without reading anything when no decision is cited", async () => {
    const { load, requested } = recordingLoad(DECISIONS);
    const checks = await checkAnswerQuotes({
      message: answer(`> ${COURT_TEXT}`),
      load,
    });

    expect(requested).toEqual([]);
    expect(checks).toEqual({
      type: "checked",
      checks: [{ type: "unchecked", key: answerQuoteKey(COURT_TEXT) }],
    });
  });

  it("stores nothing for an answer without quotations", async () => {
    const { load, requested } = recordingLoad(DECISIONS);
    expect(
      await checkAnswerQuotes({
        message: answer(`Viz [rozhodnutí](#stella-decision=${FIRST}).`),
        load,
      }),
    ).toEqual({ type: "no-quotations" });
    expect(requested).toEqual([]);
  });

  it("stores nothing when the decisions cannot be read in time", async () => {
    const failed = await checkAnswerQuotes({
      message: answer(`[1](#stella-decision=${FIRST})\n\n> ${COURT_TEXT}`),
      load: async () =>
        await Promise.reject(
          new TimeoutError({ message: "slow", label: "test" }),
        ),
    });
    const slow = await checkAnswerQuotes({
      message: answer(`[1](#stella-decision=${FIRST})\n\n> ${COURT_TEXT}`),
      load: async () =>
        await Promise.withResolvers<DecisionBlocksByDecision>().promise,
      timeoutMs: 5,
    });

    expect(failed).toEqual({ type: "unavailable" });
    expect(slow).toEqual({ type: "unavailable" });
  });

  it("ignores blockquote and link syntax inside code", async () => {
    const { load, requested } = recordingLoad(DECISIONS);
    const checks = await checkAnswerQuotes({
      message: answer(
        `\`\`\`\n> ${COURT_TEXT}\n[1](#stella-decision=${FIRST})\n\`\`\``,
      ),
      load,
    });

    expect(checks).toEqual({ type: "no-quotations" });
    expect(requested).toEqual([]);
  });

  it("keys a quotation as the renderer reads it, formatting and blocks included", async () => {
    const { load } = recordingLoad(DECISIONS);
    const [first, second] = COURT_TEXT.split(", kdo ");
    const checks = await checkAnswerQuotes({
      message: answer(
        `[1](#stella-decision=${FIRST})\n\n> **${first}**, kdo\n> ${second}`,
      ),
      load,
    });

    expect(checks).toMatchObject({
      type: "checked",
      checks: [{ type: "verified", key: answerQuoteKey(COURT_TEXT) }],
    });
  });
});
