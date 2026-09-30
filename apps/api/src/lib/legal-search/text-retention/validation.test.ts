import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  corpusContentHash,
  type CorpusPayload,
} from "@/api/lib/legal-search/corpus-payload";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";

import { assessRawPayload } from "./validation";

const bytes = (text: string) => new TextEncoder().encode(text);
const sourceOf = (text: string) => ({
  sourceKey: ADAPTER_KEYS.CZ_NS,
  contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  raw: bytes(encodeSourceRawEnvelope({ print: `<p>${text}</p>` })),
});
const payloadOf = (text: string) =>
  ({ text, sections: null, ast: null }) as const satisfies CorpusPayload;
const astOf = (text: string) =>
  ({
    version: 1,
    source: { system: "fixture", documentId: "1", webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        type: "paragraph",
        id: "1",
        anchorId: "1",
        role: "argumentation",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  }) as const satisfies DocumentAst;

describe("final payload text retention binding", () => {
  test("fingerprints bind the exact final canonical AST instead of a discarded candidate", async () => {
    const source = sourceOf("first second");
    const discarded = {
      text: null,
      sections: null,
      ast: astOf("first second"),
    } as const satisfies CorpusPayload;
    const persisted = {
      text: null,
      sections: null,
      ast: astOf("first"),
    } as const satisfies CorpusPayload;
    const before = await assessRawPayload({
      source,
      payload: discarded,
      parserVersion: 1,
    });
    const after = await assessRawPayload({
      source,
      payload: persisted,
      parserVersion: 1,
    });
    expect(
      before.verdict.status === "assessed" && before.verdict.defect,
    ).toBeNull();
    expect(after.verdict.status === "assessed" && after.verdict.defect).toBe(
      "text_loss_suspected",
    );
    expect(after.payloadFingerprint).toBe(corpusContentHash(persisted));
    expect(after.payloadFingerprint).not.toBe(before.payloadFingerprint);
    expect(after.compositionFingerprint).not.toBe(
      before.compositionFingerprint,
    );
  });

  test("every persisted representation is checked and metadata-only annotation preserves source text", async () => {
    const source = sourceOf("first second");
    const annotated = {
      ...astOf("first second"),
      metadata: {
        ...astOf("first second").metadata,
        caseNumber: "recorded docket",
      },
    };
    const clean = await assessRawPayload({
      source,
      payload: { text: "first second", sections: null, ast: annotated },
      parserVersion: 1,
    });
    expect(
      clean.verdict.status === "assessed" && clean.verdict.defect,
    ).toBeNull();
    const missingFulltext = await assessRawPayload({
      source,
      payload: { text: "first", sections: null, ast: annotated },
      parserVersion: 1,
    });
    expect(
      missingFulltext.verdict.status === "assessed" &&
        missingFulltext.verdict.defect,
    ).toBe("text_loss_suspected");
    const missingSection = await assessRawPayload({
      source,
      payload: {
        text: "first second",
        ast: annotated,
        sections: [
          { index: 0, type: "argumentation", title: null, text: "first" },
        ],
      },
      parserVersion: 1,
    });
    expect(
      missingSection.verdict.status === "assessed" &&
        missingSection.verdict.defect,
    ).toBe("text_loss_suspected");
  });

  test("extra supplement occurrences cannot compensate for a lost judgment occurrence", async () => {
    const judgmentSource = sourceOf("repeated repeated");
    const supplementSource = sourceOf("repeated");
    const result = await assessRawPayload({
      source: judgmentSource,
      payload: payloadOf("repeated repeated repeated"),
      parserVersion: 1,
      components: [
        {
          id: "judgment",
          source: judgmentSource,
          payload: payloadOf("repeated"),
        },
        {
          id: "supplement",
          source: supplementSource,
          payload: payloadOf("repeated repeated"),
        },
      ],
    });
    expect(result.verdict.status === "assessed" && result.verdict.defect).toBe(
      "text_loss_suspected",
    );
    expect(
      result.verdict.status === "assessed" && result.verdict.retainedRatio,
    ).toBe(0.5);
    expect(result.components.at(0)?.verdict).toMatchObject({
      defect: "text_loss_suspected",
      retainedRatio: 0.5,
    });
    expect(result.components.at(1)?.verdict).toMatchObject({
      status: "assessed",
      defect: null,
    });
  });

  test("aggregate validation catches composition loss even when each component is complete", async () => {
    const first = sourceOf("first");
    const second = sourceOf("second");
    const result = await assessRawPayload({
      source: first,
      payload: payloadOf("first"),
      parserVersion: 1,
      components: [
        { id: "first", source: first, payload: payloadOf("first") },
        { id: "second", source: second, payload: payloadOf("second") },
      ],
    });
    expect(
      result.components.every(
        ({ verdict }) =>
          verdict.status === "assessed" && verdict.defect === null,
      ),
    ).toBe(true);
    expect(result.verdict.status === "assessed" && result.verdict.defect).toBe(
      "text_loss_suspected",
    );
  });

  test("unavailable components and incomplete manifests cannot publish a clean outer verdict", async () => {
    const source = sourceOf("judgment");
    const missingRaw = await assessRawPayload({
      source,
      payload: payloadOf("judgment supplement"),
      parserVersion: 1,
      components: [
        { id: "judgment", source, payload: payloadOf("judgment") },
        { id: "supplement", source: null, payload: payloadOf("supplement") },
      ],
    });
    expect(missingRaw.verdict).toMatchObject({
      status: "unavailable",
      reason: "no_raw",
    });
    expect(missingRaw.components.at(1)?.verdict).toMatchObject({
      status: "unavailable",
      reason: "no_raw",
    });
    const missingJudgment = await assessRawPayload({
      source,
      payload: payloadOf("judgment supplement"),
      parserVersion: 1,
      components: [
        {
          id: "supplement",
          source: sourceOf("supplement"),
          payload: payloadOf("supplement"),
        },
      ],
    });
    expect(missingJudgment.verdict).toMatchObject({
      status: "unavailable",
      reason: "composite_unreverifiable",
    });
    const ambiguous = await assessRawPayload({
      source,
      payload: payloadOf("judgment judgment"),
      parserVersion: 1,
      components: [
        { id: "same", source, payload: payloadOf("judgment") },
        { id: "same", source, payload: payloadOf("judgment") },
      ],
    });
    expect(ambiguous.verdict).toMatchObject({
      status: "unavailable",
      reason: "ambiguous_component",
    });
  });

  test("binary baselines shared by root and components cause one stored-object read", async () => {
    const pdf = PDF.create();
    pdf.addPage().drawText("SAME SOURCE", { x: 20, y: 700 });
    const raw = await pdf.save();
    const ref = {
      location: "case-law/raw/document/shared",
      contentType: "application/pdf",
      byteLength: raw.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
    };
    let reads = 0;
    const readBinary = async () => {
      reads += 1;
      return raw;
    };
    const source = {
      sourceKey: ADAPTER_KEYS.SK_US,
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      raw: bytes(encodeSourceRawEnvelope({}, { "document-file": ref })),
      readBinary,
    };
    const supplement = {
      ...source,
      raw: bytes(
        encodeSourceRawEnvelope(
          { listing: "different component capture" },
          { "document-file": ref },
        ),
      ),
    };
    const result = await assessRawPayload({
      source,
      payload: payloadOf("SAME SOURCE SAME SOURCE"),
      parserVersion: 1,
      components: [
        { id: "judgment", source, payload: payloadOf("SAME SOURCE") },
        {
          id: "supplement",
          source: supplement,
          payload: payloadOf("SAME SOURCE"),
        },
      ],
    });
    expect(
      result.verdict.status === "assessed" && result.verdict.defect,
    ).toBeNull();
    expect(reads).toBe(1);
  });

  test("composition fingerprints retain IDs, raw identities, component outputs and final outputs", async () => {
    const source = sourceOf("unusual source sentence");
    const payload = payloadOf("unusual source sentence");
    const component = { id: "judgment", source, payload };
    const initial = await assessRawPayload({
      source,
      payload,
      parserVersion: 1,
      components: [component],
    });
    const same = await assessRawPayload({
      source,
      payload,
      parserVersion: 1,
      components: [component],
    });
    expect(same.compositionFingerprint).toBe(initial.compositionFingerprint);
    const renamed = await assessRawPayload({
      source,
      payload,
      parserVersion: 1,
      components: [{ ...component, id: "renamed" }],
    });
    const outputChanged = await assessRawPayload({
      source,
      payload,
      parserVersion: 1,
      components: [
        { ...component, payload: payloadOf("different component output") },
      ],
    });
    expect(renamed.compositionFingerprint).not.toBe(
      initial.compositionFingerprint,
    );
    expect(outputChanged.compositionFingerprint).not.toBe(
      initial.compositionFingerprint,
    );
    expect(JSON.stringify(initial)).not.toContain("unusual source sentence");
  });
});
