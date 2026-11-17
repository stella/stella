import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_INPUT_REFUSAL_CODE } from "@stll/api-contract";
import { runOutputMimeTypeOf } from "@stll/api-contract/chat-file-types";
import { DESKTOP_RUNNER_OUTPUT_MAX_BYTES } from "@stll/api-contract/desktop-runner";
import { classifyFailure } from "@stll/errors";

import type { SafeDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { readOpenLocalRunThread } from "@/api/handlers/chat/local-run-plan";
import {
  uploadUserFile,
  type UploadUserFileDependencies,
} from "@/api/handlers/chat/upload-files";
import {
  ACCOUNT_ACCESS,
  createSafeTokenHandler,
  type VerifyCaller,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { fileSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { VerifyBearerToken } from "@/api/mcp/auth";
import { verifyMcpAccessToken } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { McpOrganizationAccessError } from "@/api/mcp/errors";

/** Room a multipart body needs beyond the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const CHAT_SCOPE = "stella:chat";
const BEARER = /^Bearer (\S+)$/u;

const runIdSchema = v.pipe(v.string(), v.uuid());

export type RunOutputCaller = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

export type RunCallerDependencies = {
  /** The bearer verifier; the provider's own in production. */
  verifyToken?: VerifyBearerToken;
  resolveContext?: (
    session: Parameters<typeof resolveMcpSessionContext>[0],
    options: { request: Request },
  ) => Promise<Pick<RunOutputCaller, "safeDb" | "recordAuditEvent">>;
  readRunThread?: typeof readOpenLocalRunThread;
};

type RunOutputDependencies = RunCallerDependencies & {
  uploads?: UploadUserFileDependencies;
};

const refused = (status: 401 | 403 | 404, message: string) =>
  Result.err(new HandlerError({ status, message }));

/** The state that decides this request could not be read; the sidecar retries nothing. */
const unreadable = (message: string, cause: unknown) =>
  Result.err(
    classifyFailure(
      new HandlerError({
        status: 503,
        code: "service_unavailable",
        message,
        retryable: true,
        cause,
      }),
      "organization_state_unreadable",
    ),
  );

/**
 * The caller is the run: its agent token names this run, the member who owns it
 * and their organization, the run row confirms all three, and the row, never the
 * request, names the thread. Live membership is the MCP server's own check, so
 * a token outlives neither a member's access nor the run.
 */
export const verifyRunCaller =
  ({
    verifyToken,
    resolveContext = resolveMcpSessionContext,
    readRunThread = readOpenLocalRunThread,
  }: RunCallerDependencies): VerifyCaller<RunOutputCaller> =>
  async ({ request, params }) => {
    const bearer = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
    if (bearer === undefined) {
      return refused(401, "A run's agent token is required");
    }
    const verified = await verifyMcpAccessToken(bearer, {
      mode: "default",
      verifyToken,
    });
    if (Result.isError(verified)) {
      return verified.error._tag === "McpTokenVerificationError"
        ? Result.err(
            classifyFailure(
              new HandlerError({
                status: 503,
                code: "service_unavailable",
                message: "The token could not be verified",
                retryable: true,
                cause: verified.error,
              }),
              "upstream_unavailable",
            ),
          )
        : refused(401, "A run's agent token is required");
    }
    if (verified.value.type !== "user") {
      return refused(401, "A run's agent token is required");
    }
    const { session } = verified.value;
    const runId = v.safeParse(runIdSchema, params["runId"]);
    if (
      !runId.success ||
      session.credential?.type !== "agent_run" ||
      session.credential.runId !== runId.output
    ) {
      return refused(403, "The token does not belong to this run");
    }
    if (!session.scopes.includes(CHAT_SCOPE)) {
      return refused(403, "The token cannot write to a chat");
    }
    const context = await Result.tryPromise({
      try: async () => await resolveContext(session, { request }),
      catch: (cause) => cause,
    });
    if (Result.isError(context)) {
      if (McpOrganizationAccessError.is(context.error)) {
        return refused(403, "The member cannot write to this chat");
      }
      return unreadable("The run's member could not be read", context.error);
    }
    const { organizationId, userId } = brandActorSessionIdentity({
      organizationId: session.organizationId,
      userId: session.userId,
    });
    const thread = await readRunThread({
      owner: { organizationId, userId },
      runId: runId.output,
    });
    if (Result.isError(thread)) {
      return unreadable("The run could not be read", thread.error);
    }
    if (thread.value === null) {
      return refused(404, "This run takes no files");
    }
    return Result.ok({
      userId,
      organizationId,
      threadId: thread.value,
      safeDb: context.value.safeDb,
      recordAuditEvent: context.value.recordAuditEvent,
    });
  };

/** Stores one file a local run handed back, for the member to open from chat. */
export const createUploadRunOutput = (
  dependencies: RunOutputDependencies = {},
) =>
  createSafeTokenHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      contentDelivery: {
        type: "none",
        reason: "Stores a file a run wrote; it answers with the file's id.",
      },
      mcp: { type: "internal", reason: "upload_mechanics" },
      params: v.object({ runId: runIdSchema }),
      body: v.strictObject({
        file: v.pipe(
          fileSchema({ maxBytes: DESKTOP_RUNNER_OUTPUT_MAX_BYTES }),
          v.minSize(1),
        ),
      }),
      requestBodyMaxBytes:
        DESKTOP_RUNNER_OUTPUT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
    },
    verifyRunCaller(dependencies),
    async function* ({ body: { file }, caller }) {
      const { organizationId, recordAuditEvent, safeDb, threadId, userId } =
        caller;
      // The type comes from the name, not from the sender; the scan then holds
      // the bytes to it.
      const mimeType = runOutputMimeTypeOf(file.name);
      if (mimeType === null) {
        return Result.err(
          new HandlerError({
            code: CHAT_INPUT_REFUSAL_CODE.attachmentUnsupported,
            status: 422,
            message: "Unsupported file type",
          }),
        );
      }
      const thread = yield* Result.await(
        safeDb(
          async (tx) =>
            await tx
              .select({ workspaceId: chatThreads.workspaceId })
              .from(chatThreads)
              .where(
                and(
                  eq(chatThreads.id, threadId),
                  eq(chatThreads.userId, userId),
                  eq(chatThreads.organizationId, organizationId),
                ),
              )
              .limit(1)
              .then((rows) => rows.at(0) ?? null),
        ),
      );
      if (thread === null) {
        return refused(404, "This run takes no files");
      }
      const stored = yield* Result.await(
        uploadUserFile({
          ...(dependencies.uploads === undefined
            ? {}
            : { dependencies: dependencies.uploads }),
          file: {
            bytes: new Uint8Array(await file.arrayBuffer()),
            fileName: sanitizeFilename(file.name),
            mimeType,
          },
          isRunOutput: true,
          organizationId,
          recordAuditEvent,
          safeDb,
          threadId,
          userId,
          workspaceId: thread.workspaceId,
        }),
      );
      return Result.ok({ fileId: stored.id });
    },
  );

const uploadRunOutput = createUploadRunOutput();

declareAggregateMutation(uploadRunOutput, {
  type: "independent",
  reason:
    "Adds one immutable file row, its audit event and its storage object to the run's chat thread; it changes no aggregate's ordered state.",
});

export default uploadRunOutput;
