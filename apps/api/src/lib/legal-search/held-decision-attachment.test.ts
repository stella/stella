import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { buildCzNsSbirkaDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns-sbirka";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { heldDecisionAttachmentForAdapter } from "@/api/lib/legal-search/held-decision-attachment";
import {
  HELD_DECISION_MATCH_BASES,
  HELD_DECISION_MATCH_BASIS,
  HELD_DECISION_REVIEW,
  heldDecisionReviewOf,
} from "@/api/lib/legal-search/held-decision-attachment-values";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  CZ_NS_SBIRKA_RECORDINGS,
  czNsSbirkaRecordedPage,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

describe("the Supreme Court's collection enriches the decisions Czech sources hold", () => {
  const declaration =
    heldDecisionAttachmentForAdapter(ADAPTER_KEYS.CZ_NS_SBIRKA) ??
    panic("cz-ns-sbirka declares no attachment");

  test("every other Czech source is a host, and no other source", () => {
    const czech = Object.values(ADAPTER_MANIFESTS)
      .filter(({ country }) => country === "CZE")
      .map(({ key }) => key)
      .filter((key) => key !== ADAPTER_KEYS.CZ_NS_SBIRKA);
    expect(czech).toContain(ADAPTER_KEYS.CZ_NS);
    expect([...declaration.hostAdapterKeys].toSorted()).toEqual(
      czech.toSorted(),
    );
  });

  test("it declares its collection citations on the host and parks a docket held under another date", () => {
    expect(declaration.declaredIdentifierTypes).toEqual([
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    ]);
    expect(declaration.docketHeldUnderOtherDate).toBe("park-for-review");
  });

  test("every recorded entry's metadata passes the declared schema, so none is rejected half-read", () => {
    for (const postId of CZ_NS_SBIRKA_RECORDINGS) {
      const decision =
        buildCzNsSbirkaDecision({
          postId,
          detailHtml: czNsSbirkaRecordedPage(postId),
        }) ?? panic(`${postId} built nothing`);
      const metadata: unknown = structuredClone(
        decision.metadata[declaration.metadataKey],
      );
      expect({
        postId,
        valid: v.safeParse(declaration.metadataSchema, metadata).success,
      }).toEqual({ postId, valid: true });
    }
  });
});

describe("a parked record's review", () => {
  test("is read from the row: a host means none, otherwise the basis says which", () => {
    const reviews = HELD_DECISION_MATCH_BASES.map((matchBasis) => ({
      matchBasis,
      parked: heldDecisionReviewOf({ hostDecisionId: null, matchBasis }),
      attached: heldDecisionReviewOf({ hostDecisionId: "host", matchBasis }),
    }));
    expect(reviews).toEqual([
      {
        matchBasis: HELD_DECISION_MATCH_BASIS.ECLI,
        parked: HELD_DECISION_REVIEW.SEVERAL_HELD,
        attached: null,
      },
      {
        matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
        parked: HELD_DECISION_REVIEW.SEVERAL_HELD,
        attached: null,
      },
      {
        matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE,
        parked: HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE,
        attached: null,
      },
    ]);
  });
});
