import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SignedDigestAlgorithm } from "@/api/lib/files/cms-signed-data";
import { parseCmsSignatureFile } from "@/api/lib/files/signature-file";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  detachedCms,
  digestOf,
  FIXTURE_SIGNING_TIME,
  pemArmored,
  SIGNATURE_FIXTURE_SIGNERS,
} from "@/api/tests/fixtures/signature-files";

const content = new TextEncoder().encode("Kupní smlouva, článek 3");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("CMS signature files", () => {
  test.each(["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const)(
    "a detached signature states the %s digest of the bytes it covers",
    async (algorithm: SignedDigestAlgorithm) => {
      const parsed = parseCmsSignatureFile(
        await detachedCms(content, { digestAlgorithm: algorithm }),
      ).unwrap();
      expect(parsed).toMatchObject({
        standard: "cades",
        packaging: "detached",
        embedded: null,
        references: [
          {
            fileName: null,
            digest: { algorithm, hex: hex(await digestOf(algorithm, content)) },
          },
        ],
        signers: [
          {
            id: "layer-0.signer-0",
            name: SIGNATURE_FIXTURE_SIGNERS[0],
            signedAt: FIXTURE_SIGNING_TIME.toISOString(),
          },
        ],
      });
    },
  );

  test("co-signers stating the same digest name one signed file", async () => {
    const parsed = parseCmsSignatureFile(
      await detachedCms(content, { signers: SIGNATURE_FIXTURE_SIGNERS }),
    ).unwrap();
    expect(parsed.signers.map(({ name }) => name)).toEqual([
      ...SIGNATURE_FIXTURE_SIGNERS,
    ]);
    expect(parsed.references).toHaveLength(1);
  });

  test.each([
    ["PEM armor", (der: Uint8Array) => pemArmored(der)],
    ["a CMS PEM label", (der: Uint8Array) => pemArmored(der, "CMS")],
    [
      "bare base64",
      (der: Uint8Array) =>
        new TextEncoder().encode(Buffer.from(der).toString("base64")),
    ],
  ])("reads a signature delivered as %s", async (_label, encode) => {
    const der = await detachedCms(content);
    expect(parseCmsSignatureFile(encode(der)).unwrap()).toEqual(
      parseCmsSignatureFile(der).unwrap(),
    );
  });

  test("an attached signature carries its document like a .p7m", async () => {
    const parsed = parseCmsSignatureFile(await wrapP7m(content)).unwrap();
    expect(parsed.packaging).toBe("enveloping");
    expect(parsed.embedded?.bytes).toEqual(content);
    expect(parsed.references).toEqual([]);
  });

  test("an attached signature built with signed attributes keeps them", async () => {
    const parsed = parseCmsSignatureFile(
      await detachedCms(content, { attached: true }),
    ).unwrap();
    expect(parsed.embedded?.bytes).toEqual(content);
    expect(parsed.signers.at(0)?.signedAt).toBe(
      FIXTURE_SIGNING_TIME.toISOString(),
    );
  });

  test.each([
    [
      "a PGP signature",
      "-----BEGIN PGP SIGNATURE-----\niQEz\n-----END PGP SIGNATURE-----\n",
    ],
    ["plain text", "Signed by hand on page 3"],
    ["an empty file", ""],
  ])("does not claim %s", (_label, text) => {
    const parsed = parseCmsSignatureFile(new TextEncoder().encode(text));
    expect(parsed.isErr() && parsed.error.reason).toBe("not_signature");
  });

  test("never claims bytes that are not SignedData", () => {
    // A leading SEQUENCE tag sends the bytes down the DER path; the rest go
    // through the PEM and base64 path.
    assertProperty(
      "never claims bytes that are not SignedData",
      fc.property(
        fc.boolean(),
        fc.uint8Array({ maxLength: 512 }),
        (sequence, tail) => {
          const bytes = sequence ? Uint8Array.of(0x30, ...tail) : tail;
          const parsed = parseCmsSignatureFile(bytes);
          return parsed.isErr() && parsed.error.reason === "not_signature";
        },
      ),
    );
  });
});
