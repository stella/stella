import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { parseCertificate } from "@/api/lib/files/pdf-signing/certificate-chain";
import {
  anchorsForTimestamp,
  configuredTimestampTrust,
  operatorTimestampTrustAnchors,
  parsePinnedUnits,
  parseTrustAnchors,
  shippedTimestampTrust,
} from "@/api/lib/files/pdf-signing/timestamp-trust";
import {
  createTestCertificate,
  createTestRsaKeyPool,
} from "@/api/tests/helpers/test-pki";

const keyPool = createTestRsaKeyPool();
beforeEach(() => keyPool.reset());

const pemOf = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toBase64()
    .replaceAll(/(.{64})/gu, "$1\n")}\n-----END CERTIFICATE-----\n`;

describe("operator timestamp trust anchors", () => {
  test("reads every certificate of an inline bundle and skips broken blocks", async () => {
    const first = await createTestCertificate({
      keyPool,
      commonName: "Anchor one",
    });
    const second = await createTestCertificate({
      keyPool,
      commonName: "Anchor two",
    });
    const bundle = `${pemOf(first.der)}junk\n-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n${pemOf(second.der)}`;

    expect(
      operatorTimestampTrustAnchors(bundle).map((der) => Buffer.from(der)),
    ).toEqual([Buffer.from(first.der), Buffer.from(second.der)]);
  });

  test("reads a bundle from a path", async () => {
    const anchor = await createTestCertificate({
      keyPool,
      commonName: "Anchor",
    });
    const directory = mkdtempSync(path.join(tmpdir(), "tsa-trust-"));
    const file = path.join(directory, "anchors.pem");
    writeFileSync(file, pemOf(anchor.der));

    expect(operatorTimestampTrustAnchors(file)).toHaveLength(1);
  });

  test("trusts nothing when unset or unreadable", () => {
    expect(operatorTimestampTrustAnchors(undefined)).toEqual([]);
    expect(operatorTimestampTrustAnchors("  ")).toEqual([]);
    expect(operatorTimestampTrustAnchors("/nonexistent/anchors.pem")).toEqual(
      [],
    );
    expect(parseTrustAnchors("no certificates here")).toEqual([]);
  });
});

describe("shipped timestamp trust", () => {
  test("loads the anchors and pinned unit certificates it ships", async () => {
    const { anchors, pinnedUnits } = await shippedTimestampTrust();

    expect(anchors.length).toBeGreaterThan(0);
    expect(pinnedUnits.size).toBeGreaterThan(0);
    // Read once: the same parsed bundle every time.
    expect(await shippedTimestampTrust()).toBe(await shippedTimestampTrust());
    for (const anchor of anchors) {
      expect(parseCertificate(anchor)).not.toBeNull();
    }
    for (const fingerprint of pinnedUnits) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("the operator's anchors extend the shipped ones", async () => {
    const shipped = await shippedTimestampTrust();
    const anchor = await createTestCertificate({
      keyPool,
      commonName: "Operator anchor",
    });

    const configured = await configuredTimestampTrust(pemOf(anchor.der));
    expect(configured.anchors).toHaveLength(shipped.anchors.length + 1);
    expect(Buffer.from(configured.anchors.at(-1) ?? [])).toEqual(
      Buffer.from(anchor.der),
    );
    expect(configured.pinnedUnits).toBe(shipped.pinnedUnits);
    expect((await configuredTimestampTrust(undefined)).anchors).toHaveLength(
      shipped.anchors.length,
    );
  });

  test("a pinned unit certificate is its own anchor, any other is not", async () => {
    const unit = await createTestCertificate({ keyPool, commonName: "Unit" });
    const other = await createTestCertificate({ keyPool, commonName: "Other" });
    const ca = await createTestCertificate({ keyPool, commonName: "CA" });
    const trust = {
      anchors: [ca.der],
      pinnedUnits: parsePinnedUnits(
        `# territory and name follow the fingerprint\n\n${hashSha256Hex(unit.der)}  XX  Unit\nnot-a-fingerprint\n`,
      ),
    };

    expect(trust.pinnedUnits.size).toBe(1);
    expect(anchorsForTimestamp(trust, unit.der)).toEqual([ca.der, unit.der]);
    expect(anchorsForTimestamp(trust, other.der)).toEqual([ca.der]);
  });
});
