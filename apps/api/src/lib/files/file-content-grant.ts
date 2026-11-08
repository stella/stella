import { panic, Result } from "better-result";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedFieldId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

const FILE_CONTENT_GRANT_PREFIX = "fc1";
const FILE_CONTENT_GRANT_PATTERN =
  /^fc1\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/u;
/** The longest grant the pattern admits: prefix, payload and signature. */
export const FILE_CONTENT_GRANT_MAX_LENGTH =
  FILE_CONTENT_GRANT_PREFIX.length + 1 + 1024 + 1 + 43;

export const FILE_CONTENT_GRANT_TTL_MS = 15 * 60 * 1000;

const FILE_CONTENT_PURPOSES = [
  "download",
  "display",
  "native-display",
] as const;
export type FileContentPurpose = (typeof FILE_CONTENT_PURPOSES)[number];

const isFileContentPurpose = (value: unknown): value is FileContentPurpose =>
  FILE_CONTENT_PURPOSES.some((purpose) => purpose === value);

type FileContentGrant = {
  expiresAt: number;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  purpose: FileContentPurpose;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

type CreateFileContentGrantOptions = Omit<FileContentGrant, "expiresAt"> & {
  /** An earlier session-bound deadline; omitted grants use the default TTL. */
  expiresAt?: number;
  now: number;
  secret: string;
};

const signPayload = (payload: string, secret: string): string =>
  createHmac("sha256", secret)
    .update(`${FILE_CONTENT_GRANT_PREFIX}.${payload}`)
    .digest("base64url");

export const createFileContentGrant = ({
  expiresAt,
  fieldId,
  now,
  organizationId,
  purpose,
  secret,
  userId,
  workspaceId,
}: CreateFileContentGrantOptions): string => {
  const grantExpiresAt = expiresAt ?? now + FILE_CONTENT_GRANT_TTL_MS;
  if (
    !Number.isSafeInteger(grantExpiresAt) ||
    grantExpiresAt <= now ||
    grantExpiresAt > now + FILE_CONTENT_GRANT_TTL_MS
  ) {
    return panic("File content grant expiry must be within its maximum TTL");
  }
  const payload = Buffer.from(
    JSON.stringify({
      expiresAt: grantExpiresAt,
      fieldId,
      organizationId,
      purpose,
      userId,
      workspaceId,
    }),
  ).toString("base64url");
  return `${FILE_CONTENT_GRANT_PREFIX}.${payload}.${signPayload(payload, secret)}`;
};

type FileContentGrantCheck =
  | { status: "valid"; grant: FileContentGrant }
  | { status: "expired" | "invalid" };

export const checkFileContentGrant = ({
  grant,
  now,
  secret,
}: {
  grant: string;
  now: number;
  secret: string;
}): FileContentGrantCheck => {
  const match = FILE_CONTENT_GRANT_PATTERN.exec(grant);
  const payload = match?.at(1);
  if (!payload) {
    return { status: "invalid" };
  }
  const expected = `${FILE_CONTENT_GRANT_PREFIX}.${payload}.${signPayload(payload, secret)}`;
  if (
    expected.length !== grant.length ||
    !timingSafeEqual(Buffer.from(grant), Buffer.from(expected))
  ) {
    return { status: "invalid" };
  }

  const decoded = Result.try({
    try: (): unknown =>
      JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")),
    catch: (cause) => cause,
  });
  if (Result.isError(decoded) || !isRecord(decoded.value)) {
    return { status: "invalid" };
  }
  const value = decoded.value;
  const expiresAt = value["expiresAt"];
  const fieldId = value["fieldId"];
  const organizationId = value["organizationId"];
  const purpose = value["purpose"];
  const userId = value["userId"];
  const workspaceId = value["workspaceId"];
  if (
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    typeof fieldId !== "string" ||
    typeof organizationId !== "string" ||
    !isFileContentPurpose(purpose) ||
    typeof userId !== "string" ||
    typeof workspaceId !== "string"
  ) {
    return { status: "invalid" };
  }
  if (now > expiresAt) {
    return { status: "expired" };
  }

  return {
    status: "valid",
    grant: {
      expiresAt,
      fieldId: brandPersistedFieldId(fieldId),
      organizationId: brandPersistedOrganizationId(organizationId),
      purpose,
      userId: brandPersistedUserId(userId),
      workspaceId: brandPersistedWorkspaceId(workspaceId),
    },
  };
};
