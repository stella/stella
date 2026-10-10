import { panic, Result } from "better-result";
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
    const result = softLawIdentityKey("cz-uoou", {
      ...metadata,
      issuedOn: { state: "stated", value },
    });
    if (!Result.isError(result)) {
      panic("Invalid issue date was accepted");
    }
    expect(result.error).toBeInstanceOf(SoftLawItemError);
    expect(result.error).toMatchObject({
      tag: "invalid_document",
      message: "Issue date is not a valid ISO date",
    });
  }
  const fullwidth = {
    ...metadata,
    statedReference: { state: "stated", value: "０２/２０２４" },
  } as const;
  expect(softLawIdentityKey("cz-uoou", fullwidth).unwrap()).toBe(
    softLawIdentityKey("cz-uoou", metadata).unwrap(),
  );
  expect(fullwidth.statedReference.value).toBe("０２/２０２４");
});

test("missing stated identity fields return classified errors", () => {
  const invalidMetadata = [
    { ...metadata, title: " \t" },
    { ...metadata, statedReference: { state: "stated", value: " \n" } },
  ] as const satisfies readonly SoftLawMetadata[];
  for (const value of invalidMetadata) {
    const result = softLawIdentityKey("cz-uoou", value);
    if (!Result.isError(result)) {
      panic("Empty identity field was accepted");
    }
    expect(result.error).toBeInstanceOf(SoftLawItemError);
    expect(result.error.tag).toBe("invalid_document");
  }
  expect(
    softLawIdentityKey("cz-uoou", {
      ...metadata,
      title: "  Guidance  ",
      statedReference: { state: "not_stated" },
      issuedOn: { state: "stated", value: "2024-02-29" },
    }).unwrap(),
  ).toBe(JSON.stringify(["cz-uoou", "title", "guidance", "2024-02-29"]));
});
