import { describe, expect, test } from "bun:test";
import path from "node:path";

import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { parseCertificate } from "@/api/lib/files/pdf-signing/certificate-chain";
import { assessTimestamp } from "@/api/lib/files/pdf-signing/timestamp-assessment";
import { validateTimestampToken } from "@/api/lib/files/pdf-signing/timestamp-token";
import { shippedTimestampTrust } from "@/api/lib/files/pdf-signing/timestamp-trust";
import { settled } from "@/api/tests/helpers/settled";

const permit = grantThirdPartyOutboundPermit();
const COMMON_NAME_OID = "2.5.4.3";

/** What the recorded requests asked to have timestamped. */
const RECORDED_DATA = "stella timestamp fixture\n";

/**
 * One token per public authority stella documents, each recorded from a
 * single RFC 3161 request over `RECORDED_DATA`. Both carry their root
 * cross-signed by an older one, which is the case the chain builder must
 * not follow past the shipped anchor.
 */
const RECORDED_TOKENS = [
  {
    authority: "http://timestamp.digicert.com",
    file: "timestamp-token-digicert.der",
    genTime: new Date("2026-11-12T09:53:20Z"),
    root: "DigiCert Trusted Root G4",
  },
  {
    authority: "http://timestamp.sectigo.com",
    file: "timestamp-token-sectigo.der",
    genTime: new Date("2026-11-12T09:53:23Z"),
    root: "Sectigo Public Time Stamping Root R46",
  },
] as const;

const commonName = (der: Uint8Array | undefined) =>
  der === undefined
    ? undefined
    : parseCertificate(der)?.subject.typesAndValues.find(
        ({ type }) => type === COMMON_NAME_OID,
      )?.value.valueBlock.value;

describe("recorded tokens from the documented public authorities", () => {
  for (const { authority, file, genTime, root } of RECORDED_TOKENS) {
    test(`${authority} chains to the shipped ${root}`, async () => {
      const token = await Bun.file(
        path.join(import.meta.dir, "__fixtures__", file),
      ).bytes();
      const validated = await settled(
        validateTimestampToken({
          digest: new Uint8Array(hashSha256Bytes(RECORDED_DATA)),
          now: genTime,
          token,
        }),
      );

      const fetched: string[] = [];
      const assessed = await assessTimestamp({
        // Offline: the shipped anchor must complete the chain on its own.
        fetcher: async ({ url }) => {
          fetched.push(url);
          return null;
        },
        permit,
        timestamp: validated,
        trust: await shippedTimestampTrust(),
      });

      expect(assessed.trusted).toBe(true);
      expect(assessed.complete).toBe(true);
      expect(commonName(assessed.chain.at(-1))).toBe(root);
      expect(fetched).toEqual([]);

      // Without the shipped anchors the same token is not vouched for.
      const bare = await assessTimestamp({
        fetcher: async () => null,
        permit,
        timestamp: validated,
        trust: { anchors: [], pinnedUnits: new Set() },
      });
      expect(bare.trusted).toBe(false);
    });
  }
});
