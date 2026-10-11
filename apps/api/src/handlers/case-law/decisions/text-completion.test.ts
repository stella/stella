import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  checkDecisionTextCompletion,
  decisionTextCompletionOf,
} from "./text-completion";

const descriptor = (allowsDerivedAi: boolean) => ({
  allowsDerivedAi,
  allowsRedistribution: true,
  attribution: null,
  license: "permitted-redistribution" as const,
});

test("completion eligibility always follows the current publication, licence, and revision contract", () => {
  assertProperty(
    "completion eligibility always follows the current publication, licence, and revision contract",
    fc.property(
      fc.record({
        preparedPublished: fc.boolean(),
        preparedRedistributable: fc.boolean(),
        preparedDerivedAi: fc.boolean(),
        currentPublished: fc.boolean(),
        currentRedistributable: fc.boolean(),
        currentDerivedAi: fc.boolean(),
        revisionChanged: fc.boolean(),
        documentUrlChanged: fc.boolean(),
      }),
      ({
        preparedPublished,
        preparedRedistributable,
        preparedDerivedAi,
        currentPublished,
        currentRedistributable,
        currentDerivedAi,
        revisionChanged,
        documentUrlChanged,
      }) => {
        const expectedRevision = "revision-before";
        const currentRevision = revisionChanged
          ? "revision-after"
          : expectedRevision;
        const expected = decisionTextCompletionOf({
          published: preparedPublished,
          redistributable: preparedRedistributable,
          textRevisionFingerprint: expectedRevision,
          documentUrl: "https://example.test/before",
          descriptor: descriptor(preparedDerivedAi),
        });
        const current = decisionTextCompletionOf({
          published: currentPublished,
          redistributable: currentRedistributable,
          textRevisionFingerprint: currentRevision,
          documentUrl: documentUrlChanged
            ? "https://example.test/after"
            : "https://example.test/before",
          descriptor: descriptor(currentDerivedAi),
        });

        const actual = checkDecisionTextCompletion(
          expected.textEligibilityFingerprint,
          current,
        );
        const preparedStateChanged =
          preparedPublished !== currentPublished ||
          preparedRedistributable !== currentRedistributable ||
          preparedDerivedAi !== currentDerivedAi ||
          revisionChanged ||
          documentUrlChanged;
        if (!currentPublished || !currentRedistributable) {
          expect(actual).toEqual({
            type: "incomplete",
            reason: "missing_text",
          });
          return;
        }
        if (!currentDerivedAi) {
          expect(actual).toEqual({
            type: "withheld",
            reason: "source_licence",
          });
          return;
        }
        if (preparedStateChanged) {
          expect(actual).toEqual({
            type: "incomplete",
            reason: "text_changed",
          });
          return;
        }
        expect(actual).toEqual({ type: "eligible" });
      },
    ),
  );
});
