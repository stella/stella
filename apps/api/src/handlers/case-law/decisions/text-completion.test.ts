import { expect, expectTypeOf, test } from "bun:test";

import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";

import {
  checkDecisionTextCompletion,
  decisionTextCompletionOf,
} from "./text-completion";
import type {
  readDecisionTextCompletion,
  readDecisionTextCompletions,
} from "./text-completion";

const preparedInput = {
  country: "CZE",
  published: true,
  redistributable: true,
  textRevisionFingerprint: "prepared-revision",
  documentUrl: "https://example.test/prepared-document",
  descriptor: {
    allowsDerivedAi: true,
  },
} as const satisfies Parameters<typeof decisionTextCompletionOf>[0];

type CompletionCase = {
  state: string;
  current: Parameters<typeof decisionTextCompletionOf>[0];
  expected: ReturnType<typeof checkDecisionTextCompletion>;
};

const completionCases = [
  {
    state: "published, licensed, current text",
    current: preparedInput,
    expected: { type: "eligible" },
  },
  {
    state: "publication unavailable",
    current: { ...preparedInput, published: false },
    expected: { type: "incomplete", reason: "missing_text" },
  },
  {
    state: "country changed within an admitted surface",
    current: { ...preparedInput, country: "SVK" },
    expected: { type: "incomplete", reason: "text_changed" },
  },
  {
    state: "document URL changed",
    current: {
      ...preparedInput,
      documentUrl: "https://example.test/replacement",
    },
    expected: { type: "incomplete", reason: "text_changed" },
  },
  {
    state: "text revision changed",
    current: {
      ...preparedInput,
      textRevisionFingerprint: "replacement-revision",
    },
    expected: { type: "incomplete", reason: "text_changed" },
  },
  {
    state: "redistribution withdrawn",
    current: { ...preparedInput, redistributable: false },
    expected: { type: "incomplete", reason: "missing_text" },
  },
  {
    state: "derived-text use withdrawn despite a changed revision",
    current: {
      ...preparedInput,
      textRevisionFingerprint: "replacement-revision",
      descriptor: { ...preparedInput.descriptor, allowsDerivedAi: false },
    },
    expected: {
      type: "withheld",
      reason: DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE,
    },
  },
] satisfies readonly CompletionCase[];

test.each(completionCases)(
  "completion returns text only for a published, licensed, current state: $state",
  ({ current, expected }) => {
    const prepared = decisionTextCompletionOf(preparedInput);
    const completion = decisionTextCompletionOf(current);
    expect(
      checkDecisionTextCompletion(
        prepared.textEligibilityFingerprint,
        completion,
      ),
    ).toEqual(expected);
  },
);

test("completion reads require the admitted countries at every boundary", () => {
  type Single = Parameters<typeof readDecisionTextCompletion>[0];
  type Batch = Parameters<typeof readDecisionTextCompletions>[0];
  expectTypeOf<Omit<Single, "countries">>().not.toExtend<Single>();
  expectTypeOf<Omit<Batch, "countries">>().not.toExtend<Batch>();
});

test("a disappeared completion snapshot cannot return prepared text", () => {
  const prepared = decisionTextCompletionOf(preparedInput);
  expect(
    checkDecisionTextCompletion(prepared.textEligibilityFingerprint, undefined),
  ).toEqual({
    type: "incomplete",
    reason: "missing_text",
  });
});
