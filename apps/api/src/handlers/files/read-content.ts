import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import type { TokenHandlerConfig, VerifyCaller } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  checkFileContentGrant,
  FILE_CONTENT_GRANT_MAX_LENGTH,
} from "@/api/lib/files/file-content-grant";
import { readFileContentHandler } from "@/api/lib/files/read-file";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "public",
    reason:
      "Redeems a short-lived HMAC-bound grant that was audited when issued and rechecks version liveness before reading storage.",
  },
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: v.object({
    grant: v.pipe(v.string(), v.maxLength(FILE_CONTENT_GRANT_MAX_LENGTH)),
  }),
} satisfies TokenHandlerConfig;

type ReadFileContentDependencies = {
  database?: TokenScopedDatabase;
  now?: () => number;
};

type VerifiedFileContentGrant = Extract<
  ReturnType<typeof checkFileContentGrant>,
  { status: "valid" }
>["grant"];

/** The grant in the path is the caller's only credential. */
const verifyFileContentGrant =
  (now: () => number): VerifyCaller<VerifiedFileContentGrant> =>
  ({ params }) => {
    const checked = checkFileContentGrant({
      grant: params["grant"] ?? "",
      now: now(),
      secret: env.BETTER_AUTH_SECRET,
    });
    return checked.status === "valid"
      ? Result.ok(checked.grant)
      : Result.err(
          new HandlerError({ status: 404, message: "File grant not found." }),
        );
  };

/** The mounted endpoint's factory; tests inject the database and clock. */
export const createReadFileContentEndpoint = ({
  database = tokenScopedDatabase,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: ReadFileContentDependencies = {}) =>
  createSafeTokenHandler(
    config,
    verifyFileContentGrant(now),
    async function* ({ caller: grant, request }) {
      const response = yield* Result.await(
        Result.tryPromise(
          async () =>
            await readFileContentHandler({
              abortSignal: request.signal,
              fieldId: grant.fieldId,
              organizationId: grant.organizationId,
              purpose: grant.purpose,
              scopedDb: database.scoped({
                organizationId: grant.organizationId,
                userId: grant.userId,
                workspaceIds: [grant.workspaceId],
              }),
              workspaceId: grant.workspaceId,
            }),
        ),
      );
      return Result.ok(response);
    },
  );

export const readFileContentEndpoint = createReadFileContentEndpoint();
