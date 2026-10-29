import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  czNssAdapter,
  parseCzNssDetailMetadata,
} from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import {
  decodeNssDocument,
  isNssDocumentPlaceholder,
  nssRegistryDocumentUrl,
  nssRegistryUrl,
} from "@/api/handlers/case-law/ingestion/adapters/cz-nss-documents";
import { READ_OUTCOME_METADATA_KEY } from "@/api/lib/errors/read-outcome";
import { czNssFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import {
  nssRecoveryFixture,
  nssRecoveryReference,
} from "@/api/tests/helpers/cz-nss-recovery";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const fixtures = new URL("__fixtures__/", import.meta.url);

describe("NSS document recovery", () => {
  test("recognizes the publisher placeholder regardless of line endings and UTF encoding", async () => {
    const placeholder = await Bun.file(
      new URL("cz-nss-extended-chamber-placeholder.html", fixtures),
    ).text();
    for (const html of [
      placeholder,
      placeholder.replaceAll("\n", "\r\n"),
      "<html><body>\n N/A \n</body></html>",
    ]) {
      for (const bytes of [
        Buffer.from(html, "utf-8"),
        Buffer.from(html, "utf16le"),
      ]) {
        const decoded = decodeNssDocument(bytes);
        expect(decoded).toBe(html);
        expect(isNssDocumentPlaceholder(decoded)).toBe(true);
      }
    }
    const text = "Nejvyšší správní soud rozhodl ve věci žalobce.";
    expect(decodeNssDocument(Buffer.from(text, "utf16le"), "utf-16le")).toBe(
      text,
    );
    expect(isNssDocumentPlaceholder("<p>Věc se vrací pátému senátu.</p>")).toBe(
      false,
    );
  });

  test("replay rejects placeholder documents in legacy and envelope payloads", async () => {
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("NSS replay required");
    }
    for (const html of [
      "N/A",
      "<html><body>\n N/A \n</body></html>",
      "<html><body></body></html>",
    ]) {
      for (const payload of [
        { raw: html, contentType: "text/html" },
        {
          raw: encodeSourceRawEnvelope({ document: html }),
          contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        },
      ]) {
        const replay = await reparse({
          raw: new TextEncoder().encode(payload.raw),
          contentType: payload.contentType,
          caseNumber: nssRecoveryReference,
          sourceDocumentId: "641220",
          language: "cs",
          court: "Nejvyšší správní soud",
          ecli: null,
          decisionDate: null,
          decisionType: null,
          sourceUrl: null,
          documentUrl: null,
          metadata: {},
        });
        expect(replay).toMatchObject({
          type: "rejected",
          rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        });
      }
    }
  });

  test("scalar detail fields belong to the current decision while related values remain evidence", () => {
    const detail = parseCzNssDetailMetadata(`
      <div class="detcard" data-nss="nssview" data-field-id="ecli"><span class="det-textval">ECLI:CZ:NSS:2017:5.As.140.2014.76</span></div>
      <div class="detcard" data-nss="nssview" data-field-id="datumvydanirozhodnuti"><span class="det-textval">02.02.2017</span></div>
      <table><tbody><tr>
        <td class="det-textval" data-field-id="ecli">ECLI:CZ:NSS:2016:5.As.140.2014.53</td>
        <td class="det-textval" data-field-id="datumvydanirozhodnuti">26.05.2016</td>
      </tr></tbody></table>`);
    expect(detail.ecli).toBe("ECLI:CZ:NSS:2017:5.As.140.2014.76");
    expect(detail.decisionDate).toBe("02.02.2017");
    expect(detail.detailFieldEvidence).toEqual([
      {
        type: "related",
        field: "ecli",
        values: ["ECLI:CZ:NSS:2016:5.As.140.2014.53"],
      },
      {
        type: "related",
        field: "datumvydanirozhodnuti",
        values: ["26.05.2016"],
      },
    ]);
  });

  test("conflicting current scalar values remain typed evidence without a fabricated value", () => {
    const detail = parseCzNssDetailMetadata(`
      <div class="detcard" data-nss="nssview" data-field-id="ecli"><span class="det-textval">ECLI:CZ:NSS:2017:5.As.140.2014.76</span></div>
      <div class="detcard" data-nss="nssview" data-field-id="ecli"><span class="det-textval">ECLI:CZ:NSS:2016:5.As.140.2014.53</span></div>
      <div class="detcard" data-nss="nssview" data-field-id="datumvydanirozhodnuti"><span class="det-textval">02.02.2017</span><span class="det-textval">26.05.2016</span></div>`);
    expect(detail.ecli).toBeUndefined();
    expect(detail.decisionDate).toBeUndefined();
    expect(detail.detailFieldEvidence).toEqual([
      {
        type: "scalar_conflict",
        field: "ecli",
        values: [
          "ECLI:CZ:NSS:2017:5.As.140.2014.76",
          "ECLI:CZ:NSS:2016:5.As.140.2014.53",
        ],
      },
      {
        type: "scalar_conflict",
        field: "datumvydanirozhodnuti",
        values: ["02.02.2017", "26.05.2016"],
      },
    ]);
  });

  test("crawl and replay store both conflicting official scalar values", async () => {
    const html = `<div data-field-id="ecli"><span class="det-textval">ECLI:CZ:NSS:2026:1.Azs.4.2026.1</span><span class="det-textval">ECLI:CZ:NSS:2026:1.Azs.4.2026.2</span></div>
      <div data-field-id="datumvydanirozhodnuti"><span class="det-textval">01.01.2026</span><span class="det-textval">02.01.2026</span></div>`;
    const expected = parseCzNssDetailMetadata(html).detailFieldEvidence;
    expect(expected).toHaveLength(2);
    const decision = await czNssFixture(html).buildDecision();
    expect(decision.ecli).toBeUndefined();
    expect(JSON.stringify(decision.metadata["detailFieldEvidence"])).toBe(
      JSON.stringify(expected),
    );
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("NSS replay required");
    }
    const replay = await reparse({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
      caseNumber: decision.caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    expect(replay.type).toBe("parsed");
    if (replay.type === "parsed") {
      expect(
        JSON.stringify(replay.result.metadata["detailFieldEvidence"]),
      ).toBe(JSON.stringify(expected));
    }
  });

  test("searches referrals by docket and selects the exact document rather than its referral", async () => {
    const url = new URL(nssRegistryUrl(nssRecoveryReference));
    expect(url.searchParams.get("filter[fileNumber_type]")).toBe("referral");
    expect(url.searchParams.get("filter[fileNumber]")).toBe("5 As 140/2014");
    const html = gunzipSync(
      await Bun.file(
        new URL("cz-nss-extended-chamber-registry.html.gz", fixtures),
      ).bytes(),
    ).toString();
    for (const [reference, document] of [
      [nssRecoveryReference, "rozhodnuti-225964-anonymizovana-verze"],
      ["5 As 140/2014-53", "rozhodnuti-208767-anonymizovana-verze"],
    ] as const) {
      const selected = nssRegistryDocumentUrl({ html, reference });
      expect(selected.isOk()).toBe(true);
      if (selected.isOk()) {
        expect(selected.value).toContain(document);
      }
    }
    const absent = nssRegistryDocumentUrl({
      html,
      reference: "5 As 140/2014-85",
    });
    expect(absent.isOk()).toBe(true);
    if (absent.isOk()) {
      expect(absent.value).toBeNull();
    }
  });

  test.each([
    "https://example.com/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze",
    "https://user:pass@www.nssoud.cz/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze",
    "/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-neanonymizovana-verze",
  ])("refuses an unsafe or non-anonymised registry document: %s", (href) => {
    const html = `<table><tbody><tr><td><a href="${href}">${nssRecoveryReference}</a></td></tr></tbody></table>`;
    const selected = nssRegistryDocumentUrl({
      html,
      reference: nssRecoveryReference,
    });
    expect(selected.isErr()).toBe(true);
    if (selected.isErr()) {
      expect(selected.error.message).toContain(
        "not an anonymized NSS original",
      );
      expect(selected.error.url).toBe("https://www.nssoud.cz");
    }
  });

  test("retains a failed original read as retryable rather than publisher text absence", async () => {
    const decision = await nssRecoveryFixture(
      () => new Response(null, { status: 503 }),
    ).buildDecision();
    expect(decision.isListingOnly).toBe(true);
    expect(decision.fulltext).toBeUndefined();
    expect(decision.metadata[READ_OUTCOME_METADATA_KEY]).toMatchObject({
      type: "unavailable",
      scope: "document",
      cause: { kind: "status", status: 503 },
    });
    expect(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.[
        "extended-chamber-registry"
      ],
    ).toContain("RS&nbsp;10/2016");
  });

  test("archives an unreadable original so parser repair can replay it", async () => {
    const bytes = "%PDF-invalid-fixture";
    const decision = await nssRecoveryFixture(
      () => new Response(bytes),
    ).buildDecision();
    expect(decision.isListingOnly).toBe(true);
    expect(decision.fulltext).toBeUndefined();
    expect(decision.metadata[READ_OUTCOME_METADATA_KEY]).toMatchObject({
      type: "unavailable",
      scope: "document",
    });
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(
      Buffer.from(
        parts?.["extended-chamber-pdf-base64"] ?? "",
        "base64",
      ).toString(),
    ).toBe(bytes);
  });

  test("recovers the original PDF and replays the archived responses without a publisher request", async () => {
    const decision = await nssRecoveryFixture().buildDecision();
    expect(decision.isListingOnly).not.toBe(true);
    expect(decision.fulltext).toContain("rozšířeného senátu");
    expect(decision.fulltext).toContain("pátému senátu");
    if (!hasUsableAst(decision.documentAst)) {
      throw new TypeError("Recovered PDF must carry a usable decision AST");
    }
    expect(decision.documentAst.blocks.length).toBeGreaterThan(20);
    expect(decision.metadata).toMatchObject({
      title: "Řízení před soudem: absence pravomoci rozšířeného senátu",
      statutes: ["k § 17 odst. 1 soudního řádu správního"],
      publicationDate: "28.04.2017",
      administrativeAuthority: "Krajský úřad Zlínského kraje",
      // The publisher repeats each reference inside its visible value,
      // including trailing separators; preserve its normalized wording.
      referencedCourtCases: {
        relation: "conflicting-precedent",
        text: "2 As 44/2011-99, 2 As 44/2011-99,, 7 As 94/2013-37, 7 As 94/2013-37,",
      },
    });
    expect(decision.sourceRaw).toBeDefined();
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["extended-chamber-registry"]).toContain("RS&nbsp;10/2016");
    expect(
      Buffer.from(parts?.["extended-chamber-pdf-base64"] ?? "", "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    globalThis.fetch = asFetchMock(() => {
      throw new TypeError("Replay must not fetch");
    });
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("NSS replay required");
    }
    const replay = await reparse({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
      caseNumber: decision.caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    expect(replay.type).toBe("parsed");
    if (replay.type === "parsed") {
      expect(replay.result.fulltext).toBe(decision.fulltext);
      expect(replay.result.documentAst).toEqual(decision.documentAst);
      expect(replay.result.metadata).toMatchObject({
        title: decision.metadata["title"],
        statutes: decision.metadata["statutes"],
        publicationDate: decision.metadata["publicationDate"],
        administrativeAuthority: decision.metadata["administrativeAuthority"],
        referencedCourtCases: decision.metadata["referencedCourtCases"],
      });
    }
  });
});
