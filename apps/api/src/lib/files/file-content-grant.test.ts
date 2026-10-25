import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  checkFileContentGrant,
  createFileContentGrant,
  FILE_CONTENT_GRANT_TTL_MS,
} from "./file-content-grant";

const NOW = 1_800_000_000_000;
const SECRET = "s".repeat(32);
const subject = {
  fieldId: toSafeId<"field">("019e7000-0000-7000-8000-000000000101"),
  organizationId: toSafeId<"organization">("organization-a"),
  purpose: "download" as const,
  userId: toSafeId<"user">("user-a"),
  workspaceId: toSafeId<"workspace">("019e7000-0000-7000-8000-000000000102"),
};

describe("file content grants", () => {
  test("round-trips the bound subject until its deadline", () => {
    const grant = createFileContentGrant({
      ...subject,
      now: NOW,
      secret: SECRET,
    });

    expect(
      checkFileContentGrant({
        grant,
        now: NOW + FILE_CONTENT_GRANT_TTL_MS,
        secret: SECRET,
      }),
    ).toEqual({
      status: "valid",
      grant: { ...subject, expiresAt: NOW + FILE_CONTENT_GRANT_TTL_MS },
    });
  });

  test("rejects expiry and tampering without exposing the subject", () => {
    const grant = createFileContentGrant({
      ...subject,
      now: NOW,
      secret: SECRET,
    });

    expect(
      checkFileContentGrant({
        grant,
        now: NOW + FILE_CONTENT_GRANT_TTL_MS + 1,
        secret: SECRET,
      }),
    ).toEqual({ status: "expired" });
    expect(
      checkFileContentGrant({
        grant: `${grant.slice(0, -1)}x`,
        now: NOW,
        secret: SECRET,
      }),
    ).toEqual({ status: "invalid" });
  });

  test("honors a shorter session-bound expiry without extending the default", () => {
    const expiresAt = NOW + 45_000;
    const grant = createFileContentGrant({
      ...subject,
      expiresAt,
      now: NOW,
      secret: SECRET,
    });

    expect(
      checkFileContentGrant({ grant, now: expiresAt, secret: SECRET }),
    ).toEqual({
      status: "valid",
      grant: { ...subject, expiresAt },
    });
    expect(
      checkFileContentGrant({ grant, now: expiresAt + 1, secret: SECRET }),
    ).toEqual({
      status: "expired",
    });
    expect(() =>
      createFileContentGrant({
        ...subject,
        expiresAt: NOW + FILE_CONTENT_GRANT_TTL_MS + 1,
        now: NOW,
        secret: SECRET,
      }),
    ).toThrow("File content grant expiry must be within its maximum TTL");
  });
});
