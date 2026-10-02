import { expect, test } from "bun:test";

import { softLawIdentityKey, softLawContentHash } from "./soft-law-fingerprint";
import { SoftLawItemError } from "./soft-law-types";
import type { SoftLawMetadata, SoftLawDocumentInput } from "./soft-law-types";

const metadata: SoftLawMetadata = {
  title: "Guidance",
  kind: "recommendation",
  statedReference: { state: "stated", value: "02/2024" },
  issuedOn: { state: "not_stated" },
  validity: { state: "not_stated", basis: "source_stated" },
};
const document: SoftLawDocumentInput = {
  metadata,
  raw: [
    {
      role: "page",
      bytes: new TextEncoder().encode("body"),
      contentType: "text/html",
    },
  ],
  text: "body",
  extractionQuality: "html",
  sourceDates: {},
};

test("soft-law contracts depend only on library owners", async () => {
  const source = await Bun.file(
    new URL("soft-law-types.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/from\s+["'][^"']*\/handlers\//u);
});

test("canonical metadata changes create a new fingerprint, including withdrawal and reversion", () => {
  const withdrawn = {
    ...document,
    metadata: {
      ...metadata,
      validity: { state: "withdrawn", basis: "source_stated" },
    },
  } as const satisfies SoftLawDocumentInput;
  expect(softLawContentHash(withdrawn)).not.toBe(softLawContentHash(document));
  const reordered = {
    ...document,
    metadata: {
      validity: metadata.validity,
      issuedOn: metadata.issuedOn,
      statedReference: metadata.statedReference,
      kind: metadata.kind,
      title: metadata.title,
    },
  };
  expect(softLawContentHash(reordered)).toBe(softLawContentHash(document));
  expect(softLawContentHash({ ...document, text: "updated extraction" })).toBe(
    softLawContentHash(document),
  );
  expect(
    softLawContentHash({ ...document, extractionQuality: "needs_ocr" }),
  ).toBe(softLawContentHash(document));
  expect(
    softLawContentHash({
      ...document,
      raw: document.raw.map((part) => ({
        ...part,
        contentType: "application/pdf",
      })),
    }),
  ).toBe(softLawContentHash(document));
  expect(
    softLawContentHash({ ...document, sourceDates: { cms: "2024-01-01" } }),
  ).not.toBe(softLawContentHash(document));
  const dates = {
    ...document,
    sourceDates: { modified: "2024-02-01", created: "2024-01-01" },
  };
  expect(
    softLawContentHash({
      ...dates,
      sourceDates: { created: "2024-01-01", modified: "2024-02-01" },
    }),
  ).toBe(softLawContentHash(dates));
  const parts = {
    ...document,
    raw: [
      ...document.raw,
      {
        role: "attachment",
        bytes: new TextEncoder().encode("attachment"),
        contentType: "application/pdf",
      },
    ],
  };
  expect(softLawContentHash({ ...parts, raw: parts.raw.toReversed() })).toBe(
    softLawContentHash(parts),
  );
});

test("issue dates are validated before storage and reference keys use NFKC without changing text", () => {
  for (const value of ["2024-1-1", "2024-02-30", "", "2024-01-01T00:00:00Z"]) {
    expect(() =>
      softLawIdentityKey("cz-uoou", {
        ...metadata,
        issuedOn: { state: "stated", value },
      }),
    ).toThrow(SoftLawItemError);
  }
  const fullwidth = {
    ...metadata,
    statedReference: { state: "stated", value: "０２/２０２４" },
  } as const;
  expect(softLawIdentityKey("cz-uoou", fullwidth)).toBe(
    softLawIdentityKey("cz-uoou", metadata),
  );
  expect(fullwidth.statedReference.value).toBe("０２/２０２４");
});
