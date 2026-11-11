import { Result } from "better-result";

import { isEntityKind } from "@stll/api-contract";
import type {
  OutlookAIAskResponse,
  OutlookAIAskSource,
} from "@stll/api-contract/outlook-ai";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { loadMatterSearchContexts } from "@/api/handlers/search/ai";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type {
  EntityGlobalSearchHit,
  GlobalSearchHit,
} from "@/api/lib/search/types";

import {
  buildEmailAskMessage,
  citedPassageNumbers,
  EMAIL_ASK_SYSTEM_PROMPT,
  EMAIL_GENERATION_TASK,
  generateEmailText,
} from "./email-generation";
import type { EmailAskPassage } from "./email-generation";
import { askEmailBodySchema } from "./schema";

const ASK_MAX_OUTPUT_TOKENS = 1024;

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "email.ask" },
  permissions: { chat: ["create"], workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The Outlook add-in's question box; agents read mail and matters through
  // their own tools.
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: askEmailBodySchema,
  requiresUsage: { actionType: "chat", modelTask: EMAIL_GENERATION_TASK },
} satisfies HandlerConfig;

const isEntityHit = (hit: GlobalSearchHit): hit is EntityGlobalSearchHit =>
  isEntityKind(hit.type);

/** A matter document the question may draw on, numbered for citation. */
export type AskPassage = EmailAskPassage & { hit: EntityGlobalSearchHit };

/**
 * The matter's own documents among the search contexts, numbered from 1 in
 * rank order. Contacts, case law and the matter record itself are left out:
 * an answer about an email cites the matter's files.
 */
type MatterSearchContext = Awaited<
  ReturnType<typeof loadMatterSearchContexts>
>[number];

export const toAskPassages = (
  contexts: readonly MatterSearchContext[],
  workspaceId: SafeId<"workspace">,
): AskPassage[] =>
  contexts
    .flatMap((context) =>
      isEntityHit(context.hit) && context.hit.workspaceId === workspaceId
        ? [{ content: context.content, hit: context.hit, title: context.title }]
        : [],
    )
    .map((passage, index) => ({ ...passage, number: index + 1 }));

/** The passages the answer cites, in the order it first cites them. */
export const citedSources = (
  answer: string,
  passages: readonly AskPassage[],
): OutlookAIAskSource[] =>
  citedPassageNumbers(answer, passages.length).flatMap((number) => {
    const passage = passages.at(number - 1);
    return passage === undefined
      ? []
      : [
          {
            number,
            entityId: passage.hit.entityId,
            workspaceId: passage.hit.workspaceId,
            fieldId: passage.hit.fileFieldId,
            title: passage.title,
          },
        ];
  });

/**
 * A plain-text answer to a question about the email in the request. With a
 * matter named, the matter's best search results for the question, read
 * through the search summary's own retrieval and the caller's access, travel
 * with the email and the answer cites them. Persists nothing.
 */
const askEmail = createSafeRootHandler(
  config,
  async function* ({
    actionSignal,
    body,
    getWorkspaceAccess,
    managedAIResidency,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    request,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    const organizationId = session.activeOrganizationId;
    // A matter is read, never written, so an archived one still answers.
    const scope = yield* resolveChatScope({
      admitted: "active-or-archived",
      getWorkspaceAccess,
      workspaceId: body.workspaceId,
    });
    const workspaceId = scope.scope === "workspace" ? scope.workspaceId : null;
    let passages: AskPassage[] = [];
    if (workspaceId !== null) {
      // The search applies the caller's token scopes: a token without matter
      // read access finds no documents, and the answer reads the email alone.
      const contexts = yield* Result.await(
        Result.tryPromise(
          async () =>
            await loadMatterSearchContexts({
              accessibleWorkspaceIds: [workspaceId],
              grantedScopes: session.grantedScopes,
              organizationId,
              query: body.question,
              scopedDb,
              userId: user.id,
              workspaceId,
            }),
        ),
      );
      passages = toAskPassages(contexts, workspaceId);
    }

    const admission = configuredModelAdmission({ modelAdmission });
    const answer = yield* Result.await(
      generateEmailText({
        request: {
          system: EMAIL_ASK_SYSTEM_PROMPT,
          message: buildEmailAskMessage({ body, passages }),
          maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
          failureMessage: "Could not answer the question. Please try again.",
        },
        admission,
        organizationId,
        userId: user.id,
        orgAIConfig,
        managedAIResidency,
        caching: resolveCaching({
          promptCachingEnabled,
          task: EMAIL_GENERATION_TASK,
          scopeKey: null,
        }),
        analytics: createTanStackAIAnalyticsCallbacks({
          dataClass: "customer",
          usageMetering: {
            actionType: "chat",
            organizationId,
            safeDb,
            serviceTier: "standard",
            userId: user.id,
            workspaceId,
          },
          feature: "email.ask",
          modelTask: EMAIL_GENERATION_TASK,
          orgAIConfig,
          modelTier: admission.modelTier,
          properties: {
            organization_id: organizationId,
            passage_count: String(passages.length),
          },
          traceId: Bun.randomUUIDv7(),
        }),
        abortSignal: actionSignal ?? request.signal,
        tenantWorkspaceIds: workspaceId === null ? [] : [workspaceId],
      }),
    );

    return Result.ok({
      answer,
      sources: citedSources(answer, passages),
    } satisfies OutlookAIAskResponse);
  },
);

declareAggregateMutation(askEmail, {
  type: "independent",
  reason:
    "Reads the named matter's search results and generates text; writes only its own usage rows, with no cross-row invariant.",
});

export default askEmail;
