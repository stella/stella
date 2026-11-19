import { expect, test } from "bun:test";

import { wrapP7m } from "@/api/tests/fixtures/p7m";

import { P7M_LIMITS, parseP7m } from "./p7m";

// The OpenSSL CMS regression suite also exercises streaming encodings and
// multiple signers: https://github.com/openssl/openssl/blob/master/test/recipes/80-test_cms.t
const binary = new Uint8Array([0, 0xff, 0x7f, 0x0d, 0x0a, 0x80, 0]);

test.each([false, true])(
  "preserves binary bytes from CMS content (constructed: %s)",
  async (constructed) => {
    const original = await wrapP7m(binary, { constructed });
    const snapshot = original.slice();
    const parsed = parseP7m(original);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    expect(Array.from(parsed.value.bytes)).toEqual(Array.from(binary));
    parsed.value.bytes.fill(0);
    expect(original).toEqual(snapshot);
  },
);

test("reports co-signers and nested signers from outermost to innermost", async () => {
  const inner = await wrapP7m(binary, { signers: ["issuer"] });
  const outer = await wrapP7m(inner, { signers: ["issuer", "issuer"] });
  const parsed = parseP7m(outer);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  expect(Array.from(parsed.value.bytes)).toEqual(Array.from(binary));
  expect(
    parsed.value.layers.map(({ signers }) =>
      signers.map(({ name }) => name).toSorted(),
    ),
  ).toEqual([
    ["Example first signer", "Example second signer"],
    ["Example first signer"],
  ]);
});

test("matches a subject key identifier to the embedded certificate", async () => {
  const parsed = parseP7m(await wrapP7m(binary, { signers: ["ski"] }));
  if (parsed.isErr()) {
    throw parsed.error;
  }
  expect(parsed.value.layers.at(0)?.signers).toEqual([
    {
      name: "Example first signer",
      issuerName: "Example first signer",
      serialNumber: "01",
      signedAt: null,
    },
  ]);
});

test("leaves names unset when identifiers are missing or ambiguous", async () => {
  const issuer = parseP7m(
    await wrapP7m(binary, { omitSignerCertificates: true }),
  );
  const ski = parseP7m(await wrapP7m(binary, { signers: ["ski", "ski"] }));
  if (issuer.isErr()) {
    throw issuer.error;
  }
  if (ski.isErr()) {
    throw ski.error;
  }
  expect(issuer.value.layers.at(0)?.signers.at(0)?.name).toBeNull();
  expect(ski.value.layers.at(0)?.signers.map(({ name }) => name)).toEqual([
    null,
    null,
  ]);
});

test("distinguishes explicitly empty content from a detached signature", async () => {
  const empty = new Uint8Array();
  const attached = parseP7m(await wrapP7m(empty));
  const detached = parseP7m(await wrapP7m(binary, { detached: true }));
  if (attached.isErr()) {
    throw attached.error;
  }
  expect(attached.value.bytes.byteLength).toBe(0);
  expect(detached.isErr() && detached.error.reason).toBe("detached");
});

test("rejects unrecognized content, trailing bytes and malformed nested SignedData", async () => {
  const unsupported = parseP7m(
    await wrapP7m(binary, { contentType: "1.2.840.113549.1.9.16.1.4" }),
  );
  const original = await wrapP7m(binary);
  const trailing = parseP7m(new Uint8Array([...original, 0]));
  const malformedInner = await wrapP7m(original.subarray(0, -1));
  const nested = parseP7m(malformedInner);
  expect(unsupported.isErr() && unsupported.error.reason).toBe(
    "unsupported_content",
  );
  expect(trailing.isErr() && trailing.error.reason).toBe("not_signed_data");
  expect(nested.isErr() && nested.error.reason).toBe("not_signed_data");
});

test("accepts the maximum envelope depth and rejects the next layer", async () => {
  let wrapped = binary;
  for (let index = 0; index < P7M_LIMITS.maxLayers; index++) {
    wrapped = await wrapP7m(wrapped);
  }
  const boundary = parseP7m(wrapped);
  const tooDeep = parseP7m(await wrapP7m(wrapped));
  if (boundary.isErr()) {
    throw boundary.error;
  }
  expect(boundary.value.layers).toHaveLength(P7M_LIMITS.maxLayers);
  expect(tooDeep.isErr() && tooDeep.error.reason).toBe("too_many_layers");
});
