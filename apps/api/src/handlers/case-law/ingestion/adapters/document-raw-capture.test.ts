import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
} from "@/api/handlers/case-law/ingestion/adapter";
import { DOCUMENT_RAW_CAPTURE } from "@/api/lib/legal-search/document-raw-capture";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  CASE_LAW_CONFORMANCE_FIXTURES,
  plSnFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { deferredSkDocumentRawFixture } from "@/api/tests/helpers/sk-document-raw-storage";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const keys = Object.values(ADAPTER_KEYS);

describe("every source declares where fetched document bodies are captured", () => {
  test("capture declarations cover exactly the adapter registry", () => {
    expect(Object.keys(DOCUMENT_RAW_CAPTURE).toSorted()).toEqual(
      keys.toSorted(),
    );
  });

  test.each(keys)(
    "%s keeps a document at its declared raw location",
    async (key) => {
      const capture = DOCUMENT_RAW_CAPTURE[key];
      if (capture.type === "deferred") {
        const fixture = await deferredSkDocumentRawFixture();
        const ref = decodeSourceRawEnvelopeObjects(fixture.raw)[
          capture.objectPart
        ];
        expect(
          ref,
          `${key}: deferred body has no envelope reference`,
        ).toBeDefined();
        expect(
          ref === undefined ? undefined : fixture.objects.get(ref.location),
        ).toEqual(fixture.bytes);
        return;
      }
      const fixture =
        key === ADAPTER_KEYS.PL_SN
          ? plSnFixture(
              new URL(
                "../parsers/__fixtures__/pl-sn-i-csk-2892-23.pdf",
                import.meta.url,
              ),
            )
          : CASE_LAW_CONFORMANCE_FIXTURES[key]();
      const decision = await fixture.buildDecision();
      const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
      expect(
        parts,
        `${key}: fetched documents need an envelope`,
      ).not.toBeNull();
      const objects = Object.entries(decision.sourceRawObjects ?? {});
      const captured =
        capture.parts.some((part) => (parts?.[part]?.length ?? 0) > 0) ||
        objects.some(
          ([part, object]) =>
            capture.objectPrefixes.some(
              (prefix) => part === prefix || part.startsWith(`${prefix}-`),
            ) && object.bytes.byteLength > 0,
        );
      expect(
        captured,
        `${key}: no document bytes at a declared raw location`,
      ).toBe(true);
      for (const [part, object] of objects) {
        expect(
          capture.objectPrefixes.some(
            (prefix) => part === prefix || part.startsWith(`${prefix}-`),
          ),
          `${key}: fetched binary ${part} has no capture declaration`,
        ).toBe(true);
        expect(object.bytes.byteLength).toBeGreaterThan(0);
        expect(object.contentType.length).toBeGreaterThan(0);
      }
    },
  );
});
