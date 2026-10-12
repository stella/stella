import { describe, expect, test } from "bun:test";

import {
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  chatDecisionPassagesIn,
  parseChatDecisionPassageHref,
  stampChatDecisionPassageHrefs,
  toChatDecisionPassageHref,
} from "./chat-decision-passage-link";
import { toSafeId } from "./safe-id";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "37286c24-6145-572e-ad27-15a1d4454d59",
);

const href = (value: string) =>
  `${CHAT_DECISION_PASSAGE_HREF_PREFIX}${value}` as const;

describe("chat decision passage links", () => {
  test("round-trips every anchor shape the parsers mint", () => {
    // `h-3`/`p-12`/`t-4` (block counters), `point7` (ECJ), `_ftn2` (footnote),
    // `p1` (the one parser that omits the separator).
    for (const anchorId of ["h-3", "p-12", "t-4", "point7", "_ftn2", "p1"]) {
      for (const courtParagraphNumber of [null, 1, 8, 1234]) {
        const target = {
          anchorId,
          courtParagraphNumber,
          decisionId: DECISION_ID,
        };
        expect(
          parseChatDecisionPassageHref(toChatDecisionPassageHref(target)),
        ).toEqual(target);
      }
    }
  });

  test("the href is the spelling the prompt asks the model to write", () => {
    // Nothing is percent-encoded, so "copy the anchor verbatim" and the
    // serializer's output are the same string; the prompt's instruction and
    // this module cannot drift into two spellings.
    expect(
      toChatDecisionPassageHref({
        anchorId: "p-12",
        courtParagraphNumber: null,
        decisionId: DECISION_ID,
      }),
    ).toBe(`${CHAT_DECISION_PASSAGE_HREF_PREFIX}${DECISION_ID}:p-12`);
    expect(
      toChatDecisionPassageHref({
        anchorId: "p-12",
        courtParagraphNumber: 8,
        decisionId: DECISION_ID,
      }),
    ).toBe(`${CHAT_DECISION_PASSAGE_HREF_PREFIX}${DECISION_ID}:p-12:8`);
  });

  test("rejects a court number that is not one positive whole number", () => {
    for (const number of [
      "0",
      "08",
      "-1",
      "1.5",
      "x",
      "",
      "99999999999999999",
    ]) {
      expect(
        parseChatDecisionPassageHref(href(`${DECISION_ID}:p-12:${number}`)),
      ).toBeNull();
    }
    expect(
      parseChatDecisionPassageHref(href(`${DECISION_ID}:p-12:8:9`)),
    ).toBeNull();
  });

  test("rejects an anchor outside the parsers' grammar", () => {
    for (const anchorId of ["", "p 12", "p.12", "§12", "p/12", "p%2D12"]) {
      expect(
        parseChatDecisionPassageHref(href(`${DECISION_ID}:${anchorId}`)),
      ).toBeNull();
    }
  });

  test("rejects a decision component that is not a uuid", () => {
    // Free text here would reach the opener as a search term and land the
    // reader on an unrelated decision.
    for (const decisionId of [
      "foo",
      "",
      "37286c24-6145-572e-ad27",
      "SYN 1/26",
    ]) {
      expect(
        parseChatDecisionPassageHref(href(`${decisionId}:p-1`)),
      ).toBeNull();
    }
  });

  test("rejects a href that is not a passage citation", () => {
    expect(parseChatDecisionPassageHref("#stella-decision=x")).toBeNull();
    // No separator: a decision reference, not a passage.
    expect(parseChatDecisionPassageHref(href(DECISION_ID))).toBeNull();
    expect(parseChatDecisionPassageHref(href(`${DECISION_ID}:`))).toBeNull();
    expect(
      parseChatDecisionPassageHref(href(`${DECISION_ID}:p-1:extra`)),
    ).toBeNull();
  });

  test("refuses to serialize a target the parser would reject", () => {
    expect(() =>
      toChatDecisionPassageHref({
        anchorId: "p 12",
        courtParagraphNumber: null,
        decisionId: DECISION_ID,
      }),
    ).toThrow("Decision passage href needs a block anchor: p 12");
    expect(() =>
      toChatDecisionPassageHref({
        anchorId: "p-12",
        courtParagraphNumber: null,
        decisionId: toSafeId<"caseLawDecision">("not-a-uuid"),
      }),
    ).toThrow("Decision passage href needs a decision uuid: not-a-uuid");
    expect(() =>
      toChatDecisionPassageHref({
        anchorId: "p-12",
        courtParagraphNumber: 2.5,
        decisionId: DECISION_ID,
      }),
    ).toThrow("Decision passage href needs a court paragraph number: 2.5");
  });
});

describe("stamping court paragraph numbers into an answer", () => {
  const OTHER_ID = toSafeId<"caseLawDecision">(
    "019a0000-0000-7000-8000-000000000201",
  );
  const numbers = new Map([[`${DECISION_ID}:p-12`, 8]]);
  const stamp = (text: string) =>
    stampChatDecisionPassageHrefs(
      text,
      ({ anchorId, decisionId }) =>
        numbers.get(`${decisionId}:${anchorId}`) ?? null,
    );

  test("names the resolved number on every citation of the numbered block", () => {
    const cited = href(`${DECISION_ID}:p-12`);
    expect(stamp(`[a](${cited}) and [b](${cited}).`)).toBe(
      `[a](${cited}:8) and [b](${cited}:8).`,
    );
  });

  test("a number the model wrote is replaced, never trusted", () => {
    expect(stamp(`[a](${href(`${DECISION_ID}:p-12:3`)})`)).toBe(
      `[a](${href(`${DECISION_ID}:p-12:8`)})`,
    );
    expect(stamp(`[a](${href(`${OTHER_ID}:p-12:3`)})`)).toBe(
      `[a](${href(`${OTHER_ID}:p-12`)})`,
    );
  });

  test("a block without a resolved number keeps the plain passage href", () => {
    const plain = `[a](${href(`${DECISION_ID}:p-13`)})`;
    expect(stamp(plain)).toBe(plain);
  });

  test("text the parser refuses passes through unchanged", () => {
    for (const text of [
      "No citations at all.",
      `[a](${href(`not-a-uuid:p-12`)})`,
      `[a](${href(`${DECISION_ID}:p 12`)})`,
      `trailing ${CHAT_DECISION_PASSAGE_HREF_PREFIX}`,
    ]) {
      expect(stamp(text)).toBe(text);
    }
  });

  test("lists the well-formed citations a text carries, in order", () => {
    expect(
      chatDecisionPassagesIn(
        `[a](${href(`${OTHER_ID}:p-1`)}) [b](${href("nope:p-2")}) [c](${href(`${DECISION_ID}:p-12:3`)})`,
      ),
    ).toEqual([
      { anchorId: "p-1", courtParagraphNumber: null, decisionId: OTHER_ID },
      { anchorId: "p-12", courtParagraphNumber: 3, decisionId: DECISION_ID },
    ]);
    expect(chatDecisionPassagesIn("no links")).toEqual([]);
  });

  test("stamping is idempotent", () => {
    const once = stamp(`[a](${href(`${DECISION_ID}:p-12`)})`);
    expect(stamp(once)).toBe(once);
  });
});
