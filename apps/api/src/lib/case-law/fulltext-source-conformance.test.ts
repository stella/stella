import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { decisionTextStateSchema } from "@stll/api-contract/case-law-fulltext-state";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { caseLawCanonicalPayload } from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import { parsePrimaryReferenceType } from "@/api/lib/legal-search/decision-primary-reference";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";

import {
  FULLTEXT_RECOVERY_KIND,
  FULLTEXT_SOURCE_POLICIES,
} from "./fulltext-source-policy";
import { decisionTextObservationState } from "./fulltext-state";

const originalFetch = globalThis.fetch;
const now = new Date("2026-10-28T12:00:00.000Z");
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.serial(
  "every decision source produces a complete full-text lifecycle state",
  () => {
    test("source registry, recovery policies and executable publication fixtures have identical keysets", () => {
      const registry = listSourceRegistrations()
        .map(({ key }) => key)
        .toSorted();
      expect(Object.keys(FULLTEXT_SOURCE_POLICIES).toSorted()).toEqual(
        registry,
      );
      expect(Object.keys(CASE_LAW_CONFORMANCE_FIXTURES).toSorted()).toEqual(
        registry,
      );
    });

    for (const registration of listSourceRegistrations()) {
      test(`${registration.key}: real canonical payload has a classified state with all branch evidence`, async () => {
        const decision = sanitizeResult(
          await CASE_LAW_CONFORMANCE_FIXTURES[
            registration.key
          ]().buildDecision(),
        );
        const payload = caseLawCanonicalPayload(decision);
        const policy = FULLTEXT_SOURCE_POLICIES[registration.key];
        for (const storage of ["postgres", "corpus"] as const) {
          const state = decisionTextObservationState({
            payload,
            caseNumberType: parsePrimaryReferenceType(decision.caseNumberType),
            storage,
            metadata: decision.metadata,
            now,
            attemptCount: 0,
          });
          expect(v.safeParse(decisionTextStateSchema, state).success).toBe(
            true,
          );
          // Every emitted field belongs to its strict branch. Removing any one
          // must destroy the proof, recovery cursor, failure or absence evidence.
          for (const field of Object.keys(state)) {
            const incomplete = Object.fromEntries(
              Object.entries(state).filter(([key]) => key !== field),
            );
            expect(
              v.safeParse(decisionTextStateSchema, incomplete).success,
            ).toBe(false);
          }
          switch (state.status) {
            case "stored":
              expect(state.storage).toBe(storage);
              expect(state.contentHash).toBe(corpusContentHash(payload));
              break;
            case "fetch_pending":
              // A fixture that delivers text inline cannot hide a parser or
              // publisher failure behind an unexplained initial queue entry.
              expect(registration.capability).toBe("crawl");
              expect(
                registration.capability === "crawl"
                  ? registration.source.documentStage
                  : null,
              ).toBe("deferred");
              expect(policy.recovery).toBe(FULLTEXT_RECOVERY_KIND.DEFERRED_PDF);
              expect(state.recovery).toEqual({ type: "verify_storage" });
              break;
            case "fetch_failed":
            case "publisher_has_no_text":
            case "metadata_only_by_source":
              // The shared schema above requires the typed cause or evidence;
              // descriptive metadata alone cannot satisfy these branches.
              break;
            default:
              state satisfies never;
          }
        }
      });
    }
  },
);
