import { expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  createSha256 as legacyHasher,
  sha256Hex as legacyHex,
  sha256Bytes as legacyBytes,
} from "@stll/sha256/node";

import { graphFingerprintOf } from "@/api/handlers/case-law/analysis/significance";
import { createCaseLawDecisionSlugCandidate } from "@/api/handlers/case-law/decisions/slug";
import { citationScopeAstHash } from "@/api/handlers/case-law/ingestion/citation-scopes";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  sourceStoredTotalNextRefreshAt,
  SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { toSafeId } from "@/api/lib/branded-types";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";
import { CITATION_TREATMENTS } from "@/api/lib/case-law/citation-vocabulary";
import { sortDeep } from "@/api/lib/sort-deep";

const texts = [
  "",
  "abc",
  "Článek\u0000📄\ud800",
  "Příliš žluťoučký kůň",
  "e\u0301",
];

// The Node owner is the pre-migration createHash implementation.
for (const text of texts) {
  test(`source fingerprints preserve envelope, object digests and object order: ${JSON.stringify(text)}`, () => {
    const storage = new Uint8Array([99, 0, 255, 128, 1, 88]);
    const page = {
      bytes: storage.subarray(1, 5),
      contentType: "application/octet-stream",
    };
    const attachment = {
      bytes: new TextEncoder().encode(text),
      contentType: "application/octet-stream",
    };
    expect(sourceFingerprint({ sourceRaw: text })).toBe(legacyHex(text));
    expect(legacyHex(page.bytes)).not.toBe(legacyHex(storage));
    for (const sourceRawObjects of [
      { page, attachment },
      { attachment, page },
    ]) {
      expect(sourceFingerprint({ sourceRaw: text, sourceRawObjects })).toBe(
        legacyHex(
          [
            text,
            ...Object.values(sourceRawObjects).map(({ bytes }) =>
              legacyHex(bytes),
            ),
          ].join("\n"),
        ),
      );
    }
  });

  test(`citation AST and slug identities preserve canonical bytes: ${JSON.stringify(text)}`, () => {
    const ast = {
      version: 1,
      source: {
        system: "test",
        documentId: "fixture",
        webUrl: "",
        printUrl: "",
      },
      blocks: [
        {
          id: "a",
          anchorId: "paragraph-a",
          type: "paragraph",
          plainText: text,
          inlines: [{ text, type: "text" }],
        },
      ],
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
    } satisfies DocumentAst;
    expect(citationScopeAstHash(ast)).toBe(
      legacyHex(JSON.stringify(sortDeep(ast))),
    );
    for (const attempt of [1, 2, 4]) {
      expect(
        createCaseLawDecisionSlugCandidate({
          baseSlug: "decision",
          identity: text,
          attempt,
        }),
      ).toBe(`decision-${legacyHex(`${text}\u0000${attempt}`).slice(0, 16)}`);
    }
  });

  test(`persisted analysis input preserves its ordered UTF-8 stream: ${JSON.stringify(text)}`, () => {
    const input = analysisInputOf({
      blocks: [{ anchorId: "paragraph-a", type: "paragraph", plainText: text }],
      decision: {
        court: text,
        country: "CZE",
        decisionType: null,
        language: "cs",
      },
      systemPrompt: text,
    });
    expect(input.fingerprint).toBe(
      legacyHasher()
        .update(text)
        .update("\n")
        .update(input.userMessage)
        .digest("hex"),
    );
  });

  test(`source refresh scheduling preserves the digest's big-endian phase: ${JSON.stringify(text)}`, () => {
    const earliest = new Date(1_700_000_000_000);
    const sourceId = toSafeId<"caseLawSource">(
      `source:${JSON.stringify(text)}`,
    );
    const phase =
      legacyBytes(sourceId).readUInt32BE(0) %
      SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS;
    const period = Math.ceil(
      (earliest.getTime() - phase) / SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
    );
    expect(sourceStoredTotalNextRefreshAt(sourceId, earliest).getTime()).toBe(
      period * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + phase,
    );
  });

  test(`significance graph fingerprints preserve vocabulary and update order: ${JSON.stringify(text)}`, () => {
    const facts = {
      citingDecisionIds: [
        toSafeId<"caseLawDecision">(`decision:${JSON.stringify(text)}`),
        toSafeId<"caseLawDecision">("second"),
      ],
      countsByCourtTier: [
        { tier: 2, count: 1 },
        { tier: 1, count: 2 },
      ],
      laterNegativeCount: 1,
      reportedInCollection: true,
      treatmentCounts: {
        negative: 1,
        neutral: 0,
        positive: 2,
        supportive: 0,
        mixed: 0,
        unclassified: 0,
      },
    };
    const old = legacyHasher().update("reported").update("\nlater-negative=1");
    for (const treatment of CITATION_TREATMENTS) {
      old.update(`\n${treatment}=${facts.treatmentCounts[treatment]}`);
    }
    for (const { tier, count } of facts.countsByCourtTier.toSorted(
      (a, b) => a.tier - b.tier,
    )) {
      old.update(`\ntier${tier}=${count}`);
    }
    for (const id of facts.citingDecisionIds) {
      old.update(`\n${id}`);
    }
    expect(graphFingerprintOf(facts)).toBe(old.digest("hex"));
  });
}
