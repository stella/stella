import { panic, Result } from "better-result";
import { expect, expectTypeOf, test } from "bun:test";

import { softLawIdentityKey, softLawContentHash } from "./soft-law-fingerprint";
import type { SoftLawAttempt } from "./soft-law-ingestion-store";
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

test("item errors exclude identity collisions and collision receipts require a computed identity", () => {
  expectTypeOf<"identity_collision">().not.toExtend<SoftLawItemError["tag"]>();
  expectTypeOf<
    Extract<SoftLawAttempt, { tag: "identity_collision" }>
  >().toExtend<{
    status: "rejected";
    identityKey: string;
  }>();
  expectTypeOf<{
    entry: SoftLawAttempt["entry"];
    count: number;
    status: "rejected";
    tag: "identity_collision";
  }>().not.toExtend<SoftLawAttempt>();
});

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

test("every raw part's bytes, presence and role contribute to version identity", () => {
  const attachment = {
    role: "attachment:one.pdf",
    bytes: new Uint8Array([0, 255, 17, 128]),
    contentType: "application/pdf",
  };
  const parts = {
    ...document,
    raw: [...document.raw, attachment],
  } satisfies SoftLawDocumentInput;
  const baseline = softLawContentHash(parts);
  const variants = [
    {
      name: "page bytes",
      raw: parts.raw.map((part) =>
        part.role === "page"
          ? { ...part, bytes: new TextEncoder().encode("changed page") }
          : part,
      ),
    },
    {
      name: "attachment bytes",
      raw: parts.raw.map((part) =>
        part.role === attachment.role
          ? { ...part, bytes: new Uint8Array([0, 255, 18, 128]) }
          : part,
      ),
    },
    { name: "removed attachment", raw: document.raw },
    {
      name: "added attachment",
      raw: [...parts.raw, { ...attachment, role: "attachment:two.pdf" }],
    },
    {
      name: "renamed attachment role",
      raw: parts.raw.map((part) =>
        part.role === attachment.role
          ? { ...part, role: "attachment:renamed.pdf" }
          : part,
      ),
    },
  ] satisfies readonly {
    name: string;
    raw: SoftLawDocumentInput["raw"];
  }[];
  expect(attachment.bytes).not.toEqual(new Uint8Array([0, 255, 18, 128]));
  for (const variant of variants) {
    expect({
      case: variant.name,
      changed: softLawContentHash({ ...parts, raw: variant.raw }) !== baseline,
    }).toEqual({ case: variant.name, changed: true });
  }
  expect(softLawContentHash({ ...parts, raw: parts.raw.toReversed() })).toBe(
    baseline,
  );
});

test("each stated metadata field independently contributes to version identity", () => {
  const stated = {
    ...metadata,
    issuedOn: { state: "stated", value: "2024-01-01" },
  } as const satisfies SoftLawMetadata;
  const validityVariants = {
    state: {
      ...stated,
      validity: { state: "withdrawn", basis: stated.validity.basis },
    },
    basis: {
      ...stated,
      validity: {
        state: stated.validity.state,
        basis: "archived_source_stated",
      },
    },
  } as const satisfies Record<
    keyof SoftLawMetadata["validity"],
    SoftLawMetadata
  >;
  const variants = {
    title: [{ ...stated, title: "Revised guidance" }],
    kind: [{ ...stated, kind: "methodology" }],
    statedReference: [
      { ...stated, statedReference: { state: "stated", value: "03/2024" } },
      { ...stated, statedReference: { state: "not_stated" } },
    ],
    issuedOn: [
      { ...stated, issuedOn: { state: "stated", value: "2024-01-02" } },
      { ...stated, issuedOn: { state: "not_stated" } },
    ],
    validity: Object.values(validityVariants),
  } as const satisfies Record<
    keyof SoftLawMetadata,
    readonly SoftLawMetadata[]
  >;
  const baseline = softLawContentHash({ ...document, metadata: stated });
  for (const [field, alternatives] of Object.entries(variants)) {
    for (const alternative of alternatives) {
      expect({
        field,
        changed:
          softLawContentHash({ ...document, metadata: alternative }) !==
          baseline,
      }).toEqual({ field, changed: true });
    }
  }
});

test("title identities normalize canonical Unicode, whitespace and case without compatibility folding", () => {
  const canonical = "Doporučení úřadu";
  const sourceForms = [
    canonical.normalize("NFD"),
    "  DOPORUČENÍ\t\nÚŘADU  ",
    "Doporučení     úřadu",
  ];
  const key = (title: string) =>
    softLawIdentityKey("cz-uoou", {
      ...metadata,
      title,
      statedReference: { state: "not_stated" },
    }).unwrap();
  expect(sourceForms.at(0)).not.toBe(canonical);
  for (const source of sourceForms) {
    expect(source).not.toBe(canonical);
    expect(key(source)).toBe(key(canonical));
  }
  const compatibilityForm = "Ｇｕｉｄａｎｃｅ";
  const ascii = "Guidance";
  expect(compatibilityForm).not.toBe(ascii);
  expect(compatibilityForm.normalize("NFKC")).toBe(ascii);
  expect(key(compatibilityForm)).not.toBe(key(ascii));
});
