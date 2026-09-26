import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configuredTimestampTrustAnchors,
  parseTrustAnchors,
  reachesTrustAnchor,
} from "@/api/lib/pdf-signing/timestamp-trust";
import { createTestCertificate } from "@/api/tests/helpers/test-pki";

const pemOf = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString("base64")
    .replaceAll(/(.{64})/gu, "$1\n")}\n-----END CERTIFICATE-----\n`;

describe("timestamp trust anchors", () => {
  test("reads every certificate of an inline bundle and skips broken blocks", async () => {
    const first = await createTestCertificate({ commonName: "Anchor one" });
    const second = await createTestCertificate({ commonName: "Anchor two" });
    const bundle = `${pemOf(first.der)}junk\n-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n${pemOf(second.der)}`;

    expect(
      configuredTimestampTrustAnchors(bundle).map((der) => Buffer.from(der)),
    ).toEqual([Buffer.from(first.der), Buffer.from(second.der)]);
  });

  test("reads a bundle from a path", async () => {
    const anchor = await createTestCertificate({ commonName: "Anchor" });
    const directory = mkdtempSync(path.join(tmpdir(), "tsa-trust-"));
    const file = path.join(directory, "anchors.pem");
    writeFileSync(file, pemOf(anchor.der));

    expect(configuredTimestampTrustAnchors(file)).toHaveLength(1);
  });

  test("trusts nothing when unset or unreadable", () => {
    expect(configuredTimestampTrustAnchors(undefined)).toEqual([]);
    expect(configuredTimestampTrustAnchors("  ")).toEqual([]);
    expect(configuredTimestampTrustAnchors("/nonexistent/anchors.pem")).toEqual(
      [],
    );
    expect(parseTrustAnchors("no certificates here")).toEqual([]);
  });

  test("matches a chain by exact certificate, not by name", async () => {
    const anchor = await createTestCertificate({ commonName: "Anchor" });
    const lookalike = await createTestCertificate({ commonName: "Anchor" });

    expect(reachesTrustAnchor([lookalike.der], [anchor.der])).toBe(false);
    expect(reachesTrustAnchor([lookalike.der, anchor.der], [anchor.der])).toBe(
      true,
    );
  });
});
