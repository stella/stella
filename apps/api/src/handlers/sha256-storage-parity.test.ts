import { expect, test } from "bun:test";

import type { FeedbackReportInput } from "@stll/api-contract/feedback";
import { createSha256, sha256Hex } from "@stll/sha256/node";
import { hashSkillPackage } from "@stll/skills/format";

import { fingerprintContactImport } from "@/api/handlers/contacts/contact-import-receipt";
import { feedbackFingerprint } from "@/api/handlers/feedback/sanitize-report";
import { legislationSourceHash } from "@/api/handlers/legislation/revision";
import { legislationQueryFingerprint } from "@/api/handlers/legislation/search";
import { computeRulesHash } from "@/api/handlers/playbooks/derive-ask";
import { suggestionFingerprint } from "@/api/handlers/time-entries/suggestions/cluster";
import { toSafeId } from "@/api/lib/branded-types";
import type { LegislationExpressionClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { TierStandardPosition } from "@/api/lib/workflow/position-runtime";

// The Node owner preserves the former createHash recipe independently of Bun.
const texts = ["", "abc", "Příliš žluťoučký kůň 📄 中文", "e\u0301"];
const sourceId = toSafeId<"legislationSource">("sha256_parity_source");

for (const text of texts) {
  test(`bundled skill identities retain source and ordered NUL-delimited resources: ${JSON.stringify(text)}`, () => {
    const resources = [
      {
        kind: "reference",
        path: "references/článek.md",
        content: text,
        sizeBytes: new TextEncoder().encode(text).byteLength,
      },
      {
        kind: "template",
        path: "templates/é.txt",
        content: "e\u0301",
        sizeBytes: 3,
      },
    ] as const;
    const legacy = createSha256().update(text);
    for (const resource of resources) {
      legacy
        .update("\0")
        .update(resource.path)
        .update("\0")
        .update(resource.content);
    }
    expect(hashSkillPackage({ source: text, resources })).toBe(
      legacy.digest("hex"),
    );
    expect(hashSkillPackage({ source: text, resources: [] })).toBe(
      sha256Hex(text),
    );
  });

  test(`contact import receipts retain recursively sorted JSON and omitted fields: ${JSON.stringify(text)}`, () => {
    const rows = [
      { z: text, a: { z: undefined, b: text, a: [text, undefined] } },
    ];
    const encoded = JSON.stringify(text);
    const previous = `{"rows":[{"a":{"a":[${encoded},null],"b":${encoded}},"z":${encoded}}],"version":1}`;
    expect(fingerprintContactImport(rows)).toBe(sha256Hex(previous));
    expect(fingerprintContactImport([])).toBe(
      sha256Hex('{"rows":[],"version":1}'),
    );
  });

  test(`feedback deduplication preserves report JSON and nullable instance: ${JSON.stringify(text)}`, () => {
    const report = {
      kind: "bug",
      area: "documents",
      title: text,
      whatHappened: text,
      context: { client: "web", route: text },
    } as const satisfies FeedbackReportInput;
    for (const instance of [undefined, text]) {
      expect(feedbackFingerprint(report, instance)).toBe(
        sha256Hex(JSON.stringify([report, instance ?? null])),
      );
    }
  });

  test(`time suggestion identities retain the day and earliest key delimiter: ${JSON.stringify(text)}`, () => {
    expect(suggestionFingerprint("2026-10-08", text)).toBe(
      sha256Hex(`2026-10-08\n${text}`),
    );
  });

  test(`playbook derived question cache keys preserve grading field and rule order: ${JSON.stringify(text)}`, () => {
    const position = {
      mode: "graded",
      sourceId: "11111111-1111-4111-8111-111111111111",
      issue: text,
      severity: "high",
      ask: { mode: "auto" },
      enabled: true,
      standard: {
        source: "tiers",
        tiers: {
          acceptable: {
            rules: [
              { id: "a", text },
              { id: "b", text: "é" },
            ],
          },
          fallback: { entries: [] },
          notAcceptable: { rules: [{ id: "n", text: "e\u0301" }] },
        },
      },
    } as const satisfies TierStandardPosition;
    const expected = {
      issue: text,
      acceptableRuleTexts: [text, "é"],
      fallbackTexts: [],
      notAcceptableRuleTexts: ["e\u0301"],
      check: null,
    };
    expect(computeRulesHash(position)).toBe(
      sha256Hex(JSON.stringify(expected)),
    );
    const checked = {
      ...position,
      check: { kind: "presence", expectation: "required" },
    } as const satisfies TierStandardPosition;
    expect(computeRulesHash(checked)).toBe(
      sha256Hex(JSON.stringify({ ...expected, check: checked.check })),
    );
  });

  test(`legislation cursor fingerprints retain filter positions and exclude pagination: ${JSON.stringify(text)}`, () => {
    expect(legislationQueryFingerprint({ query: text })).toBe(
      sha256Hex(
        JSON.stringify([
          "legislation",
          text,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ]),
      ),
    );
    const body = {
      query: text,
      jurisdiction: "CZE",
      documentType: text,
      status: text,
      source: sourceId,
      language: "cs",
      dateFrom: "2020-01-01",
      dateTo: "2026-10-08",
      limit: 5,
      cursor: "ignored",
    } as const;
    expect(legislationQueryFingerprint(body)).toBe(
      sha256Hex(
        JSON.stringify([
          "legislation",
          text,
          "CZE",
          text,
          text,
          sourceId,
          "cs",
          "2020-01-01",
          "2026-10-08",
        ]),
      ),
    );
  });

  test(`legislation stored source identities retain optional fields and classification suffix: ${JSON.stringify(text)}`, () => {
    const input = {
      sourceId,
      eli: text,
      title: text,
      country: "CZE",
      language: "cs",
      version: { type: "unversioned" },
      rawHash: text,
    } as const satisfies LegislationDocumentInput;
    const window = { versionValidFrom: null, versionValidTo: null };
    const previous = [
      text,
      text,
      "CZE",
      "cs",
      null,
      "current",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {},
      text,
      null,
    ];
    const classifications = [
      {
        expressionKind: "consolidation",
        windowDisposition: "effective",
        windowDispositionBasis: null,
      },
      {
        expressionKind: "unversioned",
        windowDisposition: "effective",
        windowDispositionBasis: null,
      },
      {
        expressionKind: "promulgated",
        windowDisposition: "effective",
        windowDispositionBasis: null,
      },
      {
        expressionKind: "consolidation",
        windowDisposition: "withdrawn",
        windowDispositionBasis: "publisher-unlisted",
      },
    ] as const satisfies readonly LegislationExpressionClassification[];
    for (const classification of classifications) {
      const suffix =
        classification.expressionKind === "promulgated" ||
        classification.windowDisposition === "withdrawn"
          ? [
              [
                classification.expressionKind,
                classification.windowDisposition,
                classification.windowDispositionBasis,
              ],
            ]
          : [];
      expect(legislationSourceHash(input, window, classification)).toBe(
        sha256Hex(JSON.stringify([...previous, ...suffix])),
      );
    }
    const populated = {
      ...input,
      documentType: "act",
      status: "historical",
      effectiveDate: "2020-01-01",
      fulltext: text,
      sourceUrl: "https://example.test/statute",
      documentUrl: "https://example.test/statute.pdf",
      metadata: { text },
      sourceRawContentType: "application/xml",
    } as const satisfies LegislationDocumentInput;
    expect(
      legislationSourceHash(
        populated,
        { versionValidFrom: "2020-01-01", versionValidTo: "2026-01-01" },
        classifications[0],
      ),
    ).toBe(
      sha256Hex(
        JSON.stringify([
          text,
          text,
          "CZE",
          "cs",
          "act",
          "historical",
          "2020-01-01",
          "2020-01-01",
          "2026-01-01",
          text,
          null,
          null,
          populated.sourceUrl,
          populated.documentUrl,
          { text },
          text,
          "application/xml",
        ]),
      ),
    );
  });
}
