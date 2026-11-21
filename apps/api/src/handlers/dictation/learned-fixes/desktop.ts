import { Result } from "better-result";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import {
  dictationLearnedFixChangesSchema,
  dictationLearnedFixesSchema,
} from "@stll/api-contract/dictation-learned-fixes";
import type { PermissionInput } from "@stll/permissions";

import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  changeLearnedFixes,
  clearLearnedFixes,
  readLearnedFixes,
} from "@/api/lib/dictation/learned-fixes";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { LEARNED_FIXES_MUTATION } from "./mutation";

// Learned fixes belong with dictation on the desktop, on this computer or
// with stella AI alike.
const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;

type DesktopLearnedFixesOptions = {
  authorizeAccount?: typeof authorizeDesktopAccount;
};

/** The linked desktop's member, once dictation and `permission` allow it. */
const authorizeLearnedFixes = async (
  request: Request,
  permission: PermissionInput,
  { authorizeAccount = authorizeDesktopAccount }: DesktopLearnedFixesOptions,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    if (
      !isFeatureEnabled(
        account.featureAccessSnapshot,
        REQUIRED_FEATURE_ID,
        account,
      )
    ) {
      return Result.err(
        new HandlerError({ status: 403, message: "Dictation is unavailable" }),
      );
    }
    if (!hasMemberPermission(account.memberRole, permission)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Learned dictation fixes are not permitted",
        }),
      );
    }
    return Result.ok({
      safeDb: safeDbFromScoped(account.scopedDb),
      owner: { organizationId: account.organizationId, userId: account.userId },
    });
  });

const response = safePublicHandlerResponseSchemasWithStatusText(
  dictationLearnedFixesSchema,
);

/** The linked member's learned fixes, as `GET /v1/dictation/learned-fixes` answers. */
export const createDesktopLearnedFixesListEndpoint = (
  options: DesktopLearnedFixesOptions = {},
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response,
    },
    async function* ({ request }) {
      const { safeDb, owner } = yield* Result.await(
        authorizeLearnedFixes(
          request,
          { dictationLearnedFix: ["read"] },
          options,
        ),
      );
      return Result.ok(
        yield* Result.await(
          safeDb(async (tx) => await readLearnedFixes(tx, owner)),
        ),
      );
    },
  );

/** Applies the desktop's changes, as `POST /v1/dictation/learned-fixes` does. */
export const createDesktopLearnedFixesChangeEndpoint = (
  options: DesktopLearnedFixesOptions = {},
) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        body: dictationLearnedFixChangesSchema,
        response,
      },
      async function* ({ request, body }) {
        const { safeDb, owner } = yield* Result.await(
          authorizeLearnedFixes(
            request,
            { dictationLearnedFix: ["update"] },
            options,
          ),
        );
        return Result.ok(
          yield* Result.await(
            safeDb(async (tx) => await changeLearnedFixes(tx, owner, body)),
          ),
        );
      },
    ),
    LEARNED_FIXES_MUTATION,
  );

/** Deletes everything learned, as `DELETE /v1/dictation/learned-fixes` does. */
export const createDesktopLearnedFixesClearEndpoint = (
  options: DesktopLearnedFixesOptions = {},
) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        response,
      },
      async function* ({ request }) {
        const { safeDb, owner } = yield* Result.await(
          authorizeLearnedFixes(
            request,
            { dictationLearnedFix: ["delete"] },
            options,
          ),
        );
        return Result.ok(
          yield* Result.await(
            safeDb(async (tx) => await clearLearnedFixes(tx, owner)),
          ),
        );
      },
    ),
    LEARNED_FIXES_MUTATION,
  );

export const listDesktopLearnedFixes = createDesktopLearnedFixesListEndpoint();
export const changeDesktopLearnedFixes =
  createDesktopLearnedFixesChangeEndpoint();
export const clearDesktopLearnedFixes =
  createDesktopLearnedFixesClearEndpoint();
