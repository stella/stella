import { describe, expect, test } from "bun:test";

import type { TextField } from "@stll/api-contract/case-law-text-field";
import { sha256Hex as legacyHex } from "@stll/sha256/node";

import {
  ecjCompletionFingerprint,
  ECJ_COMPLETION_PROTECTED_COLUMNS,
  protectEcjFormexParts,
  protectEcjLegacyDocument,
  protectEcjCompletion,
  type EcjCompletionStoredDecision,
} from "@/api/handlers/case-law/ingestion/eu-completion-protection";
import {
  absentDecisionTextFields,
  presentTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  encodeSourceRawEnvelope,
  type DecisionJudgeInput,
  type RawIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { sortDeep } from "@/api/lib/sort-deep";

type ProtectOptions = Omit<
  Parameters<typeof protectEcjCompletion>[0],
  "candidate"
> & { candidate: RawIngestionResult };

/** Candidates arrive branded, as the adapter's plain-text boundary emits them. */
const protect = ({ candidate, ...options }: ProtectOptions) =>
  protectEcjCompletion({
    ...options,
    candidate: plainTextIngestionResult(candidate),
  });

const stored = (): EcjCompletionStoredDecision => ({
  caseNumber: "C-1/24",
  caseNumberType: "case-number",
  sourceDocumentId: "62024CJ0001:en",
  ecli: null,
  court: "Court of Justice",
  courtId: null,
  country: "EU",
  language: "en",
  sheetNumber: null,
  decisionDate: null,
  decisionType: null,
  sourceUrl: null,
  documentUrl: null,
  fulltext: "Judgment",
  metadata: { provenance: { source: "listing" } },
  sections: null,
  documentAst: null,
  sourceRaw: "old raw",
  sourceRawS3Key: null,
  sourceRawContentType: "text/html",
  sourceHash: "source",
  parserVersion: 1,
  textS3Key: null,
  normalizedS3Key: null,
  astS3Key: null,
  contentHash: null,
  redactedAt: null,
});

const candidate = (): RawIngestionResult => ({
  caseNumber: "C-1/24",
  caseNumberType: "case-number",
  sourceDocumentId: "62024CJ0001:en",
  court: "Court of Justice",
  country: "EU",
  language: "en",
  fulltext: "Judgment",
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  documentAst: {},
  rawHash: "new",
  sourceRaw: "new raw",
  parserVersion: 2,
});

describe("completion preserves stated values", () => {
  test("adds absent values and nested provenance without dropping existing statements", () => {
    const outcome = protect({
      existing: stored(),
      judges: [],
      candidate: {
        ...candidate(),
        decisionDate: "2024-01-01",
        metadata: { provenance: { format: "Formex" } },
      },
    });
    expect(outcome.type).toBe("accepted");
    if (outcome.type !== "accepted") {
      expect.unreachable();
    }
    expect(outcome.candidate.decisionDate).toBe("2024-01-01");
    const metadata: Record<string, unknown> = outcome.candidate.metadata;
    expect(metadata).toEqual({
      provenance: { source: "listing", format: "Formex" },
    });
    expect(outcome.candidate.sourceRaw).toBe("new raw");
    const repeated = protect({
      existing: stored(),
      judges: [],
      candidate: outcome.candidate,
    });
    expect(repeated).toEqual(outcome);
  });

  test("every stored scalar rejects a differing incoming statement", () => {
    const existing = {
      ...stored(),
      ecli: "ECLI:EU:C:2024:1",
      courtId: "court",
      sheetNumber: "1",
      decisionDate: "2024-01-01",
      decisionType: "judgment",
      sourceUrl: "https://example.test/source",
      documentUrl: "https://example.test/document",
    };
    const incoming: RawIngestionResult = {
      ...candidate(),
      ecli: existing.ecli,
      courtId: existing.courtId,
      sheetNumber: existing.sheetNumber,
      decisionDate: existing.decisionDate,
      decisionType: existing.decisionType,
      sourceUrl: existing.sourceUrl,
      documentUrl: existing.documentUrl,
    };
    for (const key of ECJ_COMPLETION_PROTECTED_COLUMNS) {
      if (key === "caseNumberType") {
        expect(
          protect({
            existing,
            judges: [],
            candidate: { ...incoming, caseNumberType: "neutral-citation" },
          }),
        ).toEqual({ type: "review-required", fields: [key] });
        continue;
      }
      const outcome = protect({
        existing,
        judges: [],
        candidate: { ...incoming, [key]: "changed" },
      });
      expect(outcome).toEqual({ type: "review-required", fields: [key] });
    }
  });

  test("absence in a fetched response never removes stored scalar or publisher text", () => {
    const existing = {
      ...stored(),
      ecli: "ECLI:EU:C:2024:1",
      metadata: { headnote: "Stored headnote" },
    };
    const outcome = protect({
      existing,
      judges: [],
      candidate: { ...candidate(), fulltext: undefined },
    });
    expect(outcome.type).toBe("accepted");
    if (outcome.type !== "accepted") {
      expect.unreachable();
    }
    const ecli: string | undefined = outcome.candidate.ecli;
    expect(ecli).toBe(existing.ecli);
    expect(existing.fulltext).not.toBeNull();
    expect(outcome.candidate.fulltext ?? null).toBe(existing.fulltext);
    const headnote: TextField = outcome.candidate.textFields.headnote;
    expect(headnote).toEqual(presentTextField("Stored headnote"));
    expect(outcome.candidate.metadata).toEqual({});
  });

  test("nested metadata, arrays, publisher text and bench conflicts require review", () => {
    const outcome = protect({
      existing: {
        ...stored(),
        metadata: {
          provenance: { source: "listing" },
          authors: ["old"],
          summary: "Old summary",
        },
      },
      judges: [{ role: "panel-member", nameAsPrinted: "Old judge" }],
      candidate: {
        ...candidate(),
        metadata: { provenance: { source: "notice" }, authors: ["new"] },
        judges: [{ role: "panel-member", nameAsPrinted: "New judge" }],
        textFields: {
          ...candidate().textFields,
          summary: presentTextField("New summary"),
        },
      },
    });
    expect(outcome).toEqual({
      type: "review-required",
      fields: [
        "judges",
        "metadata.provenance.source",
        "metadata.authors",
        "textFields.summary",
      ],
    });
  });

  test("empty arrays and empty strings are stated values; null is absent", () => {
    expect(
      protect({
        existing: { ...stored(), metadata: { a: [], b: "", c: null } },
        judges: [],
        candidate: {
          ...candidate(),
          metadata: { a: ["new"], b: "new", c: "new" },
        },
      }),
    ).toEqual({
      type: "review-required",
      fields: ["metadata.a", "metadata.b"],
    });
  });

  test("publisher keys cannot mutate the metadata prototype", () => {
    const metadata: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    );
    const outcome = protect({
      existing: stored(),
      candidate: { ...candidate(), metadata },
      judges: [],
    });
    expect(outcome.type).toBe("accepted");
    if (outcome.type !== "accepted") {
      expect.unreachable();
    }
    expect(Object.hasOwn(outcome.candidate.metadata, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(outcome.candidate.metadata)).toBe(
      Object.prototype,
    );
  });

  test("redacted decisions cannot be completed", () => {
    expect(
      protect({
        existing: { ...stored(), redactedAt: new Date(0) },
        candidate: candidate(),
        judges: [],
      }),
    ).toEqual({ type: "review-required", fields: ["redactedAt"] });
  });
});

describe("claimed completion fingerprint", () => {
  test("ignores metadata key order and changes on every protected scalar", () => {
    const existing = stored();
    const digest = ecjCompletionFingerprint({ existing, judges: [] });
    expect(
      ecjCompletionFingerprint({
        existing: {
          ...existing,
          metadata: { provenance: { source: "listing" } },
        },
        judges: [],
      }),
    ).toBe(digest);
    for (const key of [
      "caseNumber",
      "sourceDocumentId",
      "ecli",
      "court",
      "courtId",
      "country",
      "language",
      "sheetNumber",
      "decisionDate",
      "decisionType",
      "sourceUrl",
      "documentUrl",
      "fulltext",
      "sourceRaw",
      "sourceRawS3Key",
      "sourceRawContentType",
      "sourceHash",
      "textS3Key",
      "normalizedS3Key",
      "astS3Key",
      "contentHash",
    ] as const) {
      expect(
        ecjCompletionFingerprint({
          existing: { ...existing, [key]: "changed" },
          judges: [],
        }),
      ).not.toBe(digest);
    }
    expect(
      ecjCompletionFingerprint({
        existing,
        judges: [{ role: "panel-member", nameAsPrinted: "Judge" }],
      }),
    ).not.toBe(digest);
    expect(
      ecjCompletionFingerprint({
        existing: { ...existing, parserVersion: 3 },
        judges: [],
      }),
    ).not.toBe(digest);
  });
});

describe("Formex-only raw preservation", () => {
  const bytes = (raw: string) => new TextEncoder().encode(raw);
  const parts = {
    notice: "notice\r\nČ",
    document: "<p>Judgment</p>",
    unknown: "",
    formex: "old",
  };
  const objects = {
    attachment: {
      location: "s3://fixture/object",
      sha256: "abc",
      contentType: "application/pdf",
      byteLength: 3,
    },
  };
  const storedRaw = bytes(encodeSourceRawEnvelope(parts, objects));

  test("permits only Formex bytes to change, including a binary candidate", () => {
    const sourceRawBytes = bytes(
      encodeSourceRawEnvelope({ ...parts, formex: "new" }, objects),
    );
    expect(
      protectEcjFormexParts({ storedRaw, candidate: { sourceRawBytes } }),
    ).toEqual({ type: "accepted" });
  });

  test.each(["notice", "document", "unknown"])(
    "rejects changed or removed %s parts",
    (key) => {
      const changed = { ...parts, [key]: "changed" };
      expect(
        protectEcjFormexParts({
          storedRaw,
          candidate: { sourceRaw: encodeSourceRawEnvelope(changed, objects) },
        }),
      ).toEqual({
        type: "review-required",
        fields: [`sourceRaw.parts.${key}`],
      });
      const removed = Object.fromEntries(
        Object.entries(parts).filter(([name]) => name !== key),
      );
      expect(
        protectEcjFormexParts({
          storedRaw,
          candidate: { sourceRaw: encodeSourceRawEnvelope(removed, objects) },
        }),
      ).toEqual({
        type: "review-required",
        fields: [`sourceRaw.parts.${key}`],
      });
    },
  );

  test("rejects added parts, missing Formex and discarded binary references", () => {
    expect(
      protectEcjFormexParts({
        storedRaw,
        candidate: {
          sourceRaw: encodeSourceRawEnvelope(
            { ...parts, added: "new" },
            objects,
          ),
        },
      }),
    ).toEqual({ type: "review-required", fields: ["sourceRaw.parts.added"] });
    expect(
      protectEcjFormexParts({
        storedRaw,
        candidate: { sourceRaw: encodeSourceRawEnvelope(parts) },
      }),
    ).toEqual({ type: "review-required", fields: ["sourceRaw.objects"] });
    const withoutFormex = {
      notice: parts.notice,
      document: parts.document,
      unknown: parts.unknown,
    };
    expect(
      protectEcjFormexParts({
        storedRaw,
        candidate: {
          sourceRaw: encodeSourceRawEnvelope(withoutFormex, objects),
        },
      }),
    ).toEqual({ type: "review-required", fields: ["sourceRaw.parts.formex"] });
  });

  test("promotes legacy document raw without changing a document byte", () => {
    const raw = "<html>Č\r\nJudgment</html>";
    expect(
      protectEcjFormexParts({
        storedRaw: bytes(raw),
        storedRawContentType: "text/html",
        candidate: {
          sourceRaw: encodeSourceRawEnvelope({ document: raw, formex: "new" }),
        },
      }),
    ).toEqual({ type: "accepted" });
  });

  test("rejects missing, malformed and non-UTF-8 raw", () => {
    for (const candidateRaw of [
      {},
      { sourceRaw: "not an envelope" },
      { sourceRawBytes: Uint8Array.of(255) },
    ]) {
      expect(
        protectEcjFormexParts({ storedRaw, candidate: candidateRaw }),
      ).toEqual({ type: "review-required", fields: ["sourceRaw"] });
    }
  });
});

describe("additional stated boundaries", () => {
  test("rejects a document role or publisher text hidden in candidate metadata", () => {
    expect(
      protect({
        existing: {
          ...stored(),
          metadata: { documentRole: "ruling", summary: "Stored" },
        },
        judges: [],
        candidate: {
          ...candidate(),
          documentRole: "reasons",
          metadata: { summary: "Changed" },
        },
      }),
    ).toEqual({
      type: "review-required",
      fields: ["documentRole", "textFields.summary"],
    });
  });

  test("sections and AST are stated document content, and missing candidate content preserves them", () => {
    const sections = [
      { index: 0, type: "ruling", title: null, text: "Stored ruling" },
    ] satisfies NonNullable<RawIngestionResult["sections"]>;
    const documentAst = {
      version: 1,
      source: { system: "fixture", documentId: "id", webUrl: "", printUrl: "" },
      metadata: {
        caseNumber: "C-1/24",
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [],
    } satisfies RawIngestionResult["documentAst"];
    const existing = { ...stored(), sections, documentAst };
    const incoming = candidate();
    const snapshot = JSON.stringify({ existing, incoming });
    const outcome = protect({
      existing,
      candidate: incoming,
      judges: [],
    });
    if (outcome.type !== "accepted") {
      expect.unreachable();
    }
    expect(outcome.candidate.sections).toEqual(sections);
    expect(outcome.candidate.documentAst).toEqual(documentAst);
    expect(JSON.stringify({ existing, incoming })).toBe(snapshot);
    expect(
      protect({
        existing,
        judges: [],
        candidate: {
          ...incoming,
          sections: [],
          documentAst: {
            ...documentAst,
            source: { ...documentAst.source, documentId: "other" },
          },
        },
      }),
    ).toEqual({ type: "review-required", fields: ["sections", "documentAst"] });
    expect(ecjCompletionFingerprint({ existing, judges: [] })).not.toBe(
      ecjCompletionFingerprint({ existing: stored(), judges: [] }),
    );
  });

  test("preserves the stated bench when the new response omits it", () => {
    const judges = [
      { role: "panel-member", nameAsPrinted: "Printed judge" },
    ] as const;
    const outcome = protect({
      existing: stored(),
      candidate: candidate(),
      judges,
    });
    if (outcome.type !== "accepted") {
      expect.unreachable();
    }
    const candidateJudges: readonly DecisionJudgeInput[] | undefined =
      outcome.candidate.judges;
    expect(candidateJudges).toEqual(judges);
  });

  test("fingerprint includes role, metadata, raw content and redaction state", () => {
    const existing = stored();
    const before = ecjCompletionFingerprint({ existing, judges: [] });
    for (const altered of [
      { ...existing, caseNumberType: "neutral-citation" as const },
      { ...existing, metadata: { documentRole: "reasons" } },
      { ...existing, redactedAt: new Date(0) },
    ]) {
      expect(
        ecjCompletionFingerprint({ existing: altered, judges: [] }),
      ).not.toBe(before);
    }
    expect(
      ecjCompletionFingerprint({
        existing: { ...existing, metadata: { z: 1, a: 2 } },
        judges: [],
      }),
    ).toBe(
      ecjCompletionFingerprint({
        existing: { ...existing, metadata: { a: 2, z: 1 } },
        judges: [],
      }),
    );
  });
});

describe("legacy full-refetch preservation", () => {
  const raw = "<p>Č\r\nJudgment</p>";
  const storedRaw = new TextEncoder().encode(raw);
  test("permits additional surfaces when every original document byte is retained", () => {
    expect(
      protectEcjLegacyDocument({
        storedRaw,
        storedRawContentType: "text/html",
        candidate: {
          sourceRaw: encodeSourceRawEnvelope({
            document: raw,
            listing: "new",
            notice: "new",
            formex: "new",
          }),
        },
      }),
    ).toEqual({ type: "accepted" });
  });
  test.each(["<p>Č\nJudgment</p>", "<p>Different</p>", ""])(
    "rejects changed legacy bytes: %s",
    (document) => {
      expect(
        protectEcjLegacyDocument({
          storedRaw,
          storedRawContentType: "text/html",
          candidate: { sourceRaw: encodeSourceRawEnvelope({ document }) },
        }),
      ).toEqual({
        type: "review-required",
        fields: ["sourceRaw.parts.document"],
      });
    },
  );
  test("rejects missing document and invalid original UTF-8", () => {
    expect(
      protectEcjLegacyDocument({
        storedRaw,
        candidate: { sourceRaw: encodeSourceRawEnvelope({ notice: "new" }) },
      }),
    ).toEqual({
      type: "review-required",
      fields: ["sourceRaw.parts.document"],
    });
    expect(
      protectEcjLegacyDocument({
        storedRaw: Uint8Array.of(255),
        candidate: { sourceRaw: encodeSourceRawEnvelope({ document: raw }) },
      }),
    ).toEqual({ type: "review-required", fields: ["sourceRaw"] });
  });
});

describe("full-refetch preserves every stored envelope part", () => {
  const parts = {
    listing: "original binding",
    document: "<p>Č\r\nJudgment</p>",
    unknown: "",
    formex: "original Formex",
  };
  const storedRaw = new TextEncoder().encode(encodeSourceRawEnvelope(parts));
  test("permits new notice and other surfaces without revising old parts", () => {
    expect(
      protectEcjLegacyDocument({
        storedRaw,
        candidate: {
          sourceRaw: encodeSourceRawEnvelope({
            ...parts,
            notice: "new notice",
            added: "new part",
          }),
        },
      }),
    ).toEqual({ type: "accepted" });
  });
  test.each(Object.keys(parts))(
    "rejects changed or missing stored %s even without a notice",
    (part) => {
      const changed = { ...parts, [part]: "changed" };
      expect(
        protectEcjLegacyDocument({
          storedRaw,
          candidate: { sourceRaw: encodeSourceRawEnvelope(changed) },
        }),
      ).toEqual({
        type: "review-required",
        fields: [`sourceRaw.parts.${part}`],
      });
      const missing = Object.fromEntries(
        Object.entries(parts).filter(([key]) => key !== part),
      );
      expect(
        protectEcjLegacyDocument({
          storedRaw,
          candidate: { sourceRaw: encodeSourceRawEnvelope(missing) },
        }),
      ).toEqual({
        type: "review-required",
        fields: [`sourceRaw.parts.${part}`],
      });
    },
  );
  test("rejects invalid replacement envelope and missing binary source reference", () => {
    expect(
      protectEcjLegacyDocument({
        storedRaw,
        candidate: { sourceRaw: "not an envelope" },
      }),
    ).toEqual({ type: "review-required", fields: ["sourceRaw"] });
    const objects = {
      attachment: {
        location: "s3://fixture/original",
        sha256: "abc",
        contentType: "application/pdf",
        byteLength: 3,
      },
    };
    const withObject = new TextEncoder().encode(
      encodeSourceRawEnvelope(parts, objects),
    );
    expect(
      protectEcjLegacyDocument({
        storedRaw: withObject,
        candidate: { sourceRaw: encodeSourceRawEnvelope(parts) },
      }),
    ).toEqual({
      type: "review-required",
      fields: ["sourceRaw.objects.attachment"],
    });
    expect(
      protectEcjLegacyDocument({
        storedRaw: withObject,
        candidate: { sourceRaw: encodeSourceRawEnvelope(parts, objects) },
      }),
    ).toEqual({ type: "accepted" });
  });
});

for (const text of ["", "Článek\u0000📄", "e\u0301"]) {
  test(`completion recovery fingerprints preserve the legacy canonical state: ${JSON.stringify(text)}`, () => {
    const existing = {
      ...stored(),
      sourceRaw: text,
      metadata: { z: text, a: "" },
    };
    const judges: DecisionJudgeInput[] = [
      { nameAsPrinted: text, role: "panel-member" },
    ];
    const state = {
      statements: Object.fromEntries(
        ECJ_COMPLETION_PROTECTED_COLUMNS.map((key) => [key, existing[key]]),
      ),
      metadata: existing.metadata,
      judges,
      sections: existing.sections,
      documentAst: existing.documentAst,
      sourceRaw: existing.sourceRaw,
      sourceRawS3Key: existing.sourceRawS3Key,
      sourceRawContentType: existing.sourceRawContentType,
      sourceHash: existing.sourceHash,
      parserVersion: existing.parserVersion,
      textS3Key: existing.textS3Key,
      normalizedS3Key: existing.normalizedS3Key,
      astS3Key: existing.astS3Key,
      contentHash: existing.contentHash,
      redactedAt: existing.redactedAt?.toISOString() ?? null,
    };
    expect(ecjCompletionFingerprint({ existing, judges })).toBe(
      legacyHex(JSON.stringify(sortDeep(state))),
    );
  });
}
