import { panic, Result } from "better-result";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";

import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { updateVerificationDecisionModel } from "@/api/lib/lists/verification/verdict-decider-setting";

const VERIFICATION_DECISION_MODEL_UNAVAILABLE_ERROR_CODE =
  "verification_decision_model_unavailable";

const config = {
  contract: "patch",
  description:
    "Turn on or off asking the decision model for each claim's verdict in " +
    "Anchor Verification. The generative model still finds the facts, " +
    "citations and qualifiers; the decision model's verdict replaces its " +
    "verdict only when it is confident enough. Turning it on is refused " +
    "with verification_decision_model_unavailable when the organization " +
    "has no decision model it can use, and with the AI access refusal when " +
    "the administrator may not use AI or the organization has neither its " +
    "own key nor instance models; a save that raced another " +
    "administrator's is refused with version_conflict. Changes are audited.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  mcp: { type: "internal", reason: "provider_secret" },
  body: v.strictObject({ enabled: v.boolean() }),
} satisfies HandlerConfig;

const updateVerificationDecisionModelRoute = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    // Only turning it on needs the organization's AI configuration, read
    // through the shared loader: an administrator the organization does not
    // admit to AI work, or an organization without instance models and
    // without its own key, is refused there. Turning it off never is.
    const loaded = body.enabled
      ? yield* Result.await(
          safeDb(
            async (tx) =>
              await loadOrgAIConfig(tx, { organizationId, userId: user.id }),
          ),
        )
      : Result.ok(null);
    const orgAIConfig = yield* loaded;
    const outcome = yield* Result.await(
      safeDb(
        async (tx) =>
          await updateVerificationDecisionModel(tx, {
            organizationId,
            enabled: body.enabled,
            orgAIConfig,
            recordAuditEvent,
          }),
      ),
    );
    switch (outcome.type) {
      case "updated":
        return Result.ok({ enabled: outcome.enabled });
      case "unavailable":
        return Result.err(
          new HandlerError({
            status: 409,
            code: VERIFICATION_DECISION_MODEL_UNAVAILABLE_ERROR_CODE,
            message:
              "No decision model is available to this organization; configure one first",
          }),
        );
      case "changed":
        return Result.err(
          new HandlerError({
            status: 409,
            code: API_VERSION_CONFLICT_ERROR_CODE,
            message: "The decision model setting changed; reload and try again",
          }),
        );
      default:
        outcome satisfies never;
        return panic("Unhandled verification decision model outcome");
    }
  },
);

declareAggregateMutation(updateVerificationDecisionModelRoute, {
  type: "independent",
  reason:
    "One column of the organization's settings row, written only while it still holds the value read; a concurrent save fails instead of overwriting it.",
});

export default updateVerificationDecisionModelRoute;
