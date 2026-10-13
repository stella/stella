import { expect, test } from "bun:test";

import {
  checkDecisionTextCompletion,
  decisionTextCompletionOf,
} from "./text-completion";

const preparedInput = {
  published: true,
  redistributable: true,
  textRevisionFingerprint: "prepared-revision",
  documentUrl: "https://example.test/prepared-document",
  descriptor: {
    allowsDerivedAi: true,
    allowsRedistribution: true,
    attribution: null,
    license: "permitted-redistribution",
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
