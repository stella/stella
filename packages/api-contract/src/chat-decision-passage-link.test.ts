import { describe, expect, test } from "bun:test";

import {
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  parseChatDecisionPassageHref,
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
      const target = { anchorId, decisionId: DECISION_ID };
      expect(
        parseChatDecisionPassageHref(toChatDecisionPassageHref(target)),
      ).toEqual(target);
    }
  });

  test("the href is the spelling the prompt asks the model to write", () => {
    // Nothing is percent-encoded, so "copy the anchor verbatim" and the
    // serializer's output are the same string; the prompt's instruction and
    // this module cannot drift into two spellings.
    expect(
      toChatDecisionPassageHref({ anchorId: "p-12", decisionId: DECISION_ID }),
    ).toBe(`${CHAT_DECISION_PASSAGE_HREF_PREFIX}${DECISION_ID}:p-12`);
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
      toChatDecisionPassageHref({ anchorId: "p 12", decisionId: DECISION_ID }),
    ).toThrow("Decision passage href needs a block anchor: p 12");
    expect(() =>
      toChatDecisionPassageHref({
        anchorId: "p-12",
        decisionId: toSafeId<"caseLawDecision">("not-a-uuid"),
      }),
    ).toThrow("Decision passage href needs a decision uuid: not-a-uuid");
  });
});
