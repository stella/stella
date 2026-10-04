import { Result } from "better-result";
import * as v from "valibot";

import {
  claimDesktopAccountGrant,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import { DESKTOP_ACCOUNT_PERMISSION } from "@/api/lib/business-registries/desktop/config";
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
  verifier: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  expectedUserId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
  expectedOrganizationId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
});

export const parseDesktopLinkCredentials = (input: unknown) =>
  v.safeParse(desktopLinkCredentials, input);

export const authorizeDesktopLinkGrant = async (input: unknown) => {
  const parsed = parseDesktopLinkCredentials(input);
  if (!parsed.success) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop connection grant is invalid or expired",
      }),
    );
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
