import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import {
  claimDesktopAccountGrant,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import { DESKTOP_ACCOUNT_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import {
  VerifiedDesktopDeviceProof,
  desktopProofRequestUrl,
  deviceProofRefusal,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { AUTH_PROVIDER_ID_PATTERN } from "@/api/lib/safe-id-boundaries";

const desktopLinkCredentials = v.strictObject({
  correlationId: v.pipe(v.string(), v.uuid()),
  deviceJkt: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  verifier: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  expectedUserId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
  expectedOrganizationId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
});

export const parseDesktopLinkCredentials = (input: unknown) =>
  v.safeParse(desktopLinkCredentials, input);

export const authorizeDesktopLinkGrant = async (
  input: unknown,
  request: Request,
  accountProof?: ConsumedDesktopDeviceProof,
) => {
  const parsed = parseDesktopLinkCredentials(input);
  if (!parsed.success) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop connection grant is invalid or expired",
      }),
    );
  }
  if (accountProof) {
    if (
      accountProof.proof.thumbprint !== parsed.output.deviceJkt ||
      accountProof.proof.nonce !== parsed.output.correlationId
    ) {
      return Result.err(deviceProofRefusal("desktop_device_mismatch"));
    }
  } else {
    const proof = await VerifiedDesktopDeviceProof.verify({
      request,
      expectedUrl: desktopProofRequestUrl(
        request,
        env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
      ),
      expectedThumbprint: parsed.output.deviceJkt,
      binding: { type: "link", nonce: parsed.output.correlationId },
    });
    if (proof.isErr()) {
      return proof;
    }
    const receipt = await ConsumedDesktopDeviceProof.claim({
      proof: proof.value,
    });
    if (receipt.isErr()) {
      return receipt;
    }
  }
  const consumed = await claimDesktopAccountGrant(parsed.output);
  if (consumed.isErr()) {
    return Result.err(consumed.error);
  }
  const identity = consumed.value;
  const member = await Result.tryPromise({
    try: async () => await resolveCredentialMemberAuthorization(identity),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop account is unavailable",
        cause,
      }),
  });
  if (member.isErr()) {
    return Result.err(member.error);
  }
  if (
    !member.value ||
    !isMemberRole(member.value.role) ||
    !hasMemberPermission(
      // The desktop account acts with the person's own live role.
      sessionMemberRole(member.value.role),
      DESKTOP_ACCOUNT_PERMISSION,
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop account is unavailable",
      }),
    );
  }
  return Result.ok({
    ...identity,
    scopedDb: createRootScopedDb({
      ...identity,
      workspaceIds: [],
    }),
  });
};
