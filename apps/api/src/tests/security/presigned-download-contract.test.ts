import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS } from "@/api/lib/data-export/queue";
import { FILE_READ_URL_EXPIRY_SECONDS } from "@/api/lib/files/read-file";
import {
  callerDownloadSource,
  isS3KeyInSigningScope,
  MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS,
  presignDownloadUrl,
  resetAwsS3ClientForTesting,
  S3PresignError,
  setScopedSigningEnabledForTesting,
} from "@/api/lib/s3-presign";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";

const MAX_ALLOWED_TTL_SECONDS = 900;

const noSessionAuthority = async () => await Promise.resolve(null);

describe("presigned S3 download URL TTL and prefix-scoping contract", () => {
  beforeEach(() => {
    resetAwsS3ClientForTesting();
  });

  afterEach(() => {
    resetAwsS3ClientForTesting();
  });

  test("pins the maximum presigned download TTL and shared download constants at <= 900s", () => {
    expect(MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS).toBe(
      MAX_ALLOWED_TTL_SECONDS,
    );
    expect(FILE_READ_URL_EXPIRY_SECONDS).toBeGreaterThan(0);
    expect(FILE_READ_URL_EXPIRY_SECONDS).toBeLessThanOrEqual(
      MAX_ALLOWED_TTL_SECONDS,
    );
    expect(DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS).toBeGreaterThan(0);
    expect(DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_ALLOWED_TTL_SECONDS,
    );
    expect(STYLE_SET_DOWNLOAD_TTL_SECONDS).toBeGreaterThan(0);
    expect(STYLE_SET_DOWNLOAD_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_ALLOWED_TTL_SECONDS,
    );
  });

  test("issues a 900s download URL at the contract ceiling and rejects any TTL above 900s", async () => {
    setScopedSigningEnabledForTesting(() => false);

    const baseOptions = {
      userId: "user-contract",
      source: callerDownloadSource({ id: "session-contract" }),
      readSessionAuthority: noSessionAuthority,
      scope: {
        organizationId: "org-alpha",
        workspaceId: "ws-alpha",
      },
    };

    const atCeiling = await presignDownloadUrl("org-alpha/ws-alpha/doc-1.pdf", {
      ...baseOptions,
      expiresIn: MAX_ALLOWED_TTL_SECONDS,
    });
    expect(new URL(atCeiling).searchParams.get("X-Amz-Expires")).toBe("900");

    for (const invalidExpiresIn of [
      MAX_ALLOWED_TTL_SECONDS + 1,
      3600,
      0,
      -60,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        await rejectionOf(
          presignDownloadUrl("org-alpha/ws-alpha/doc-1.pdf", {
            ...baseOptions,
            expiresIn: invalidExpiresIn,
          }),
        ),
      ).toBeInstanceOf(S3PresignError);
    }
  });

  test("keeps presigned download keys strictly prefix-scoped to org/workspace/", async () => {
    const scope = {
      organizationId: "org-1",
      workspaceId: "ws-1",
    };

    expect(isS3KeyInSigningScope("org-1/ws-1/file-a.pdf", scope)).toBe(true);
    expect(isS3KeyInSigningScope("org-1/ws-1/nested/file-a.pdf", scope)).toBe(
      true,
    );
    expect(isS3KeyInSigningScope("org-1/ws-2/file-a.pdf", scope)).toBe(false);
    expect(isS3KeyInSigningScope("org-2/ws-1/file-a.pdf", scope)).toBe(false);
    // Guard against prefix collisions without a trailing path delimiter.
    expect(isS3KeyInSigningScope("org-1/ws-10/file-a.pdf", scope)).toBe(false);
    expect(isS3KeyInSigningScope("org-10/ws-1/file-a.pdf", scope)).toBe(false);

    // Under scoped signing, a cross-workspace or cross-org key is rejected
    // before any STS session or presigned URL is minted.
    setScopedSigningEnabledForTesting(() => true);
    for (const outOfScopeKey of [
      "org-1/ws-2/file-a.pdf",
      "org-2/ws-1/file-a.pdf",
      "org-1/ws-10/file-a.pdf",
      "org-10/ws-1/file-a.pdf",
    ]) {
      expect(
        await rejectionOf(
          presignDownloadUrl(outOfScopeKey, {
            userId: "user-contract",
            expiresIn: MAX_ALLOWED_TTL_SECONDS,
            source: callerDownloadSource({ id: "session-contract" }),
            readSessionAuthority: noSessionAuthority,
            scope,
          }),
        ),
      ).toBeInstanceOf(S3PresignError);
    }
  });
});
