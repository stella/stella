import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
} from "@stll/case-law-ingestion-core/ingestion-types";
import { hasUsableAst } from "@stll/legal-ast/document-ast";

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
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

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
    testFetchState.set(
      asFetchMock(() => {
        throw new TypeError("Replay must not fetch");
      }),
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

test.each(["legacy", "superseded", "fresh-html"])(
  "stored NSS document build retains %s input without inventing a listing",
  async (retainedKind) => {
    const detail = gunzipSync(
      await Bun.file(
        new URL("cz-nss-extended-chamber-detail.html.gz", fixtures),
      ).bytes(),
    );
    const retainedHeadnote = "Retained publisher headnote.";
    const retainedParts = {
      document: "old document",
      text: "wrong old body ".repeat(100),
      "extended-chamber-pdf-base64": "invalid old PDF",
      "superseded-document": "earliest document",
      "superseded-document-1": "earlier document",
      "superseded-text": "earliest body",
      "superseded-extended-chamber-pdf-base64": "earliest PDF",
      "extended-chamber-registry": "earlier registry response",
      "fetched-detail": "earlier fetched detail",
      "superseded-fetched-detail": "earliest fetched detail",
    };
    const retainedDetail = `<div data-field-id="citace"><span class="det-textval">č. 123/2008 Sb. NSS</span></div><div data-field-id="pravnivetaupravena"><span class="det-textval">${retainedHeadnote}</span></div>`;
    const freshDetail = `<div data-field-id="citace"><span class="det-textval">č. 999/2020 Sb. NSS</span></div><div data-field-id="pravnivetaupravena"><span class="det-textval">Wrong portal headnote.</span></div>${new TextDecoder().decode(detail)}`;
    expect(parseCzNssDetailMetadata(freshDetail).legalSentence).toContain(
      "Wrong portal headnote.",
    );
    const registry = gunzipSync(
      await Bun.file(
        new URL("cz-nss-extended-chamber-registry.html.gz", fixtures),
      ).bytes(),
    );
    const pdf = await Bun.file(
      new URL("cz-nss-extended-chamber-original.pdf", fixtures),
    ).bytes();
    const urls: string[] = [];
    testFetchState.set(
      asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        urls.push(url.href);
        if (url.pathname === "/") {
          return new Response(
            '<form><input name="__RequestVerificationToken" value="test"></form>',
          );
        }
        if (url.pathname.startsWith("/DokumentDetail/Index/")) {
          return new Response(freshDetail);
        }
        if (url.pathname.startsWith("/DokumentOriginal/")) {
          if (retainedKind === "fresh-html") {
            return new Response(
              `<html><body><p>5 As 140/2014-76</p><p>USNESENÍ</p><p>${"Rozšířený senát rozhodl o předložené věci. ".repeat(30)}</p></body></html>`,
            );
          }
          return new Response(Buffer.from("N/A", "utf16le"));
        }
        if (url.pathname === "/rozhodovaci-cinnost/rozsireny-senat") {
          return new Response(registry);
        }
        if (
          url.pathname ===
          "/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze"
        ) {
          return new Response(pdf, {
            headers: { "content-type": "application/pdf" },
          });
        }
        throw new TypeError(`Unexpected exact recovery request: ${url.href}`);
      }),
    );
    try {
      const recover = czNssAdapter.buildStoredDocument;
      if (recover === undefined) {
        throw new TypeError("NSS recovery required");
      }
      const result = await recover({
        reference: nssRecoveryReference,
        signal: AbortSignal.timeout(10_000),
        stored: {
          raw: new TextEncoder().encode(
            retainedKind === "legacy"
              ? "N/A"
              : encodeSourceRawEnvelope({
                  ...retainedParts,
                  detail: retainedDetail,
                }),
          ),
          contentType:
            retainedKind === "legacy"
              ? "text/html"
              : SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
          caseNumber: "5 As 140/2014",
          sourceDocumentId: "641220",
          language: "cs",
          court: "Nejvyšší správní soud",
          ecli: "ECLI:CZ:NSS:2017:5.As.140.2014.76",
          decisionDate: "2017-02-02",
          decisionType: "Usnesení",
          sourceUrl: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/641220",
          documentUrl: null,
          metadata: {
            publisherOwned: ["retained", 123],
            citation: "č. 123/2008 Sb. NSS",
            legalSentence: retainedHeadnote,
            publishedCaseNumber: nssRecoveryReference,
          },
        },
      });
      expect(result.type).toBe("built");
      if (result.type !== "built") {
        return;
      }
      expect(result.decision.fulltext).toContain("5 As 140/2014");
      expect(JSON.stringify(result.decision.metadata["publisherOwned"])).toBe(
        JSON.stringify(["retained", 123]),
      );
      expect(
        Bun.deepEquals(result.decision.textFields.legalSentence, {
          type: "present",
          text: retainedHeadnote,
        }),
      ).toBe(true);
      expect(
        result.decision.identifiers
          ?.map((identifier) => identifier.value)
          .join(" "),
      ).toContain("123/2008");
      expect(
        result.decision.identifiers
          ?.map((identifier) => identifier.value)
          .join(" "),
      ).not.toContain("999/2020");
      const parts = decodeSourceRawEnvelope(result.decision.sourceRaw ?? "");
      expect(parts?.["fetched-detail"]).toBe(freshDetail);
      expect(parts?.["detail"]).toBe(
        retainedKind === "legacy" ? undefined : retainedDetail,
      );
      expect(parts?.["listing"]).toBeUndefined();
      if (retainedKind === "legacy") {
        expect(parts?.["retained-input"]).toBe("N/A");
      } else {
        expect(parts?.["superseded-extended-chamber-pdf-base64-1"]).toBe(
          "invalid old PDF",
        );
        expect(parts?.["text"] ?? "").not.toContain("wrong old body");
        expect(parts?.["superseded-text-1"]).toContain("wrong old body");
        for (const value of Object.values(retainedParts)) {
          expect(Object.values(parts ?? {})).toContain(value);
        }
      }
      if (retainedKind === "fresh-html") {
        expect(parts?.["extended-chamber-pdf-base64"]).toBeUndefined();
        expect(result.decision.fulltext).toContain("Rozšířený senát rozhodl");
        expect(urls.some((url) => url.includes("/rozsireny-senat"))).toBe(
          false,
        );
      } else {
        expect(parts?.["extended-chamber-pdf-base64"]).toBeDefined();
      }
      expect(urls.some((url) => url.includes("/Home/"))).toBe(false);
    } finally {
      testFetchState.restore();
    }
  },
);
