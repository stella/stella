import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";

type OperationalFeatureEffect = "record-recovery" | "cleanup";

type FeatureDefinition = {
  enrolment: "invitation" | "self-serve";
  deploymentFeature?: DeploymentFeatureFlag;
  ownership?: {
    handlerDirectories: readonly string[];
    tableSchemaFiles: readonly string[];
    conditionalTableSchemas?: Readonly<Record<string, readonly string[]>>;
    coreModules: readonly string[];
    conditionalModules?: readonly string[];
    dispatchModules?: readonly (
      | { type: "registry"; module: string; registry: string }
      | {
          type: "admitted";
          module: string;
          admission: string;
          /** Where the admission comes from; the MCP feature gate by default. */
          specifier?: string;
        }
      | {
          type: "operational";
          module: string;
          effects: readonly OperationalFeatureEffect[];
          owners: readonly {
            effect: OperationalFeatureEffect;
            module: string;
            exports: readonly string[];
          }[];
          reason: string;
        }
    )[];
  };
};

export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;

export const SIGNALS_FEATURE_ID = "signals";
export const FLOWS_FEATURE_ID = "flows";
export const SELF_SERVE_FEATURE_IDS = [
  "time-billing",
  SIGNALS_FEATURE_ID,
  FLOWS_FEATURE_ID,
] as const;
export const LIST_VERIFICATION_FEATURE_ID = "list-verification";
export const GENERATED_VIEWS_FEATURE_ID = "generated-views";

export const FEATURE_REGISTRY = {
  [GENERATED_VIEWS_FEATURE_ID]: {
    enrolment: "invitation",
    deploymentFeature: "FEATURE_GENERATED_VIEWS",
    ownership: {
      handlerDirectories: [],
      tableSchemaFiles: [],
      coreModules: ["apps/api/src/handlers/chat/tools/show-visual-tools.ts"],
      dispatchModules: [
        {
          type: "admitted",
          module: "apps/api/src/handlers/chat/tools/chat-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
      ],
    },
  },
  "time-billing": {
    enrolment: "self-serve",
    deploymentFeature: "FEATURE_TIME_BILLING",
    ownership: {
      handlerDirectories: [
        "apps/api/src/handlers/billing-codes",
        "apps/api/src/handlers/expenses",
        "apps/api/src/handlers/invoices",
        "apps/api/src/handlers/number-series",
        "apps/api/src/handlers/rates",
        "apps/api/src/handlers/saved-time-narratives",
        "apps/api/src/handlers/seller-profiles",
        "apps/api/src/handlers/time-entries",
        "apps/api/src/handlers/time-timers",
        "apps/api/src/handlers/vat-rates",
      ],
      tableSchemaFiles: [],
      coreModules: [],
      // Registries expose metadata; dispatch owners admit each selected tool.
      // Their callers need no enrolment for unrelated chat.
      dispatchModules: [
        {
          type: "registry",
          module: "apps/api/src/mcp/static-tool-definitions.ts",
          registry: "DEFAULT_MCP_TOOL_SETS",
        },
        {
          type: "admitted",
          module:
            "apps/api/src/handlers/chat/tools/registry-adapter/run-registry-tool.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        {
          type: "admitted",
          module:
            "apps/api/src/handlers/chat/tools/registry-adapter/run-registry-write-tool.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        {
          // The review organization reset seeds time-billing sample data
          // only where the deployment offers the feature.
          type: "admitted",
          module: "apps/api/src/lib/review-organization/time-billing-seed.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
      ],
    },
  },
  [SIGNALS_FEATURE_ID]: {
    enrolment: "self-serve",
    deploymentFeature: "FEATURE_SIGNALS",
    ownership: {
      handlerDirectories: ["apps/api/src/handlers/signals"],
      tableSchemaFiles: [],
      conditionalTableSchemas: {
        "apps/api/src/db/schema/signals.ts": [
          "signals",
          "signalEvents",
          "scoutRuns",
          "pendingScoutEmissions",
        ],
      },
      coreModules: [
        "apps/api/src/lib/signals/read.ts",
        "apps/api/src/lib/signals/emit.ts",
        "apps/api/src/lib/signals/scout.ts",
        "apps/api/src/lib/signals/proofs/may-create-signal-request.ts",
        "apps/api/src/lib/signals/proofs/signal-visible-to.ts",
      ],
      conditionalModules: [
        "apps/api/src/handlers/entity-views/rows/list.ts",
        "apps/api/src/handlers/entity-views/rows/inbox-view.ts",
      ],
      dispatchModules: [
        {
          type: "admitted",
          module: "apps/api/src/lib/signals/resume-after-grant.ts",
          admission: "isBackgroundFeatureEnabled",
          specifier: "@/api/lib/feature-access/background",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/signals/grant-recovery.ts",
          effects: ["record-recovery"],
          owners: [
            {
              effect: "record-recovery",
              module: "apps/api/src/lib/signals/resume-after-grant.ts",
              exports: ["resumeSignalsAfterGrant"],
            },
          ],
          reason:
            "Resumes retained skips after a committed grant without returning feature data.",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/feature-access/background.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
        {
          type: "registry",
          module: "apps/api/src/lib/review-organization/reset-census.ts",
          registry: "REVIEW_RESET_SWEEP",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/signals/reset-cleanup.ts",
          effects: ["cleanup"],
          owners: [
            {
              effect: "cleanup",
              module: "apps/api/src/lib/signals/reset-cleanup-owner.ts",
              exports: [
                "cleanupScoutRuns",
                "cleanupSignalEvents",
                "cleanupSignals",
              ],
            },
          ],
          reason:
            "Reset removes retained feature data and records its own deletion counts in the same transaction without returning feature counts to the generic sweep.",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/entities/signal-window-rows.ts",
          admission: "isFeatureEnabled",
          specifier: "@/api/lib/auth/feature-access/policy",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/scouts/document-deadline-recovery.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/scheduler/tasks/scout-emission-recovery.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
        {
          type: "registry",
          module: "apps/api/src/lib/feature-access/registry.ts",
          registry: "SELF_SERVE_FEATURE_IDS",
        },
        {
          type: "admitted",
          module: "apps/api/src/mcp/capability-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/scouts/document-review-recovery.ts",
          effects: ["record-recovery"],
          owners: [
            {
              effect: "record-recovery",
              module: "apps/api/src/lib/scouts/document-review.ts",
              exports: ["maybeEmitDocumentReviewSignal"],
            },
          ],
          reason:
            "Source writes retain an emission receipt while admission is absent; emission admits its actor and exposes no signal result to the source caller.",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/scouts/infosoud-hearings-recovery.ts",
          effects: ["record-recovery"],
          owners: [
            {
              effect: "record-recovery",
              module: "apps/api/src/lib/scouts/infosoud-hearings.ts",
              exports: ["emitInfoSoudHearingSignals"],
            },
          ],
          reason:
            "Source writes retain an emission receipt while admission is absent; emission admits its actor and exposes no signal result to the source caller.",
        },
        ...[
          "apps/api/src/lib/scouts/document-deadlines.ts",
          "apps/api/src/lib/scouts/document-review.ts",
          "apps/api/src/lib/scouts/work-attention.ts",
        ].map(
          (module) =>
            ({
              type: "admitted",
              module,
              admission: "isBackgroundFeatureEnabled",
              specifier: "@/api/lib/feature-access/background",
            }) as const,
        ),
      ],
    },
  },
  [FLOWS_FEATURE_ID]: {
    enrolment: "self-serve",
    deploymentFeature: "FEATURE_FLOWS",
    ownership: {
      handlerDirectories: ["apps/api/src/handlers/flows"],
      tableSchemaFiles: [],
      conditionalTableSchemas: {
        "apps/api/src/db/schema/flows.ts": [
          "flowDefinitions",
          "flowRuns",
          "flowRunSteps",
          "flowUploadTriggerIntents",
        ],
      },
      coreModules: [
        "apps/api/src/lib/flows/start-flow-run.ts",
        "apps/api/src/lib/flows/automated-run-cap.ts",
        "apps/api/src/lib/flows/flow-executor.ts",
        "apps/api/src/lib/flows/flow-run-queue.ts",
        "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
        "apps/api/src/lib/flows/flow-run-transitions.ts",
        "apps/api/src/lib/flows/flow-run-events.ts",
        "apps/api/src/lib/flows/flow-run-actor.ts",
        "apps/api/src/lib/flows/flow-run-completion-notice.ts",
      ],
      conditionalModules: [
        "apps/api/src/lib/flows/review-gate-task.ts",
        "apps/api/src/lib/tasks/update-task.ts",
        "apps/api/src/handlers/tasks/get.ts",
        "apps/api/src/handlers/tasks/update.ts",
        "apps/api/src/handlers/work-obligations/update.ts",
        "apps/api/src/handlers/work-obligations/transition.ts",
        "apps/api/src/handlers/fields/kanban-placement/update.ts",
      ],
      dispatchModules: [
        {
          type: "admitted",
          module: "apps/api/src/auth.ts",
          admission: "deliverFlowRunWorkspaceEvent",
          specifier: "@/api/lib/flows/flow-run-events",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/flows/resume-after-grant.ts",
          admission: "isBackgroundFeatureEnabled",
          specifier: "@/api/lib/feature-access/background",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/flows/grant-recovery.ts",
          effects: ["record-recovery"],
          owners: [
            {
              effect: "record-recovery",
              module: "apps/api/src/lib/flows/resume-after-grant.ts",
              exports: ["resumeFlowsAfterGrant"],
            },
          ],
          reason:
            "Resumes retained skips after a committed grant without returning feature data.",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/feature-access/background.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
        {
          type: "registry",
          module: "apps/api/src/lib/review-organization/reset-census.ts",
          registry: "REVIEW_RESET_SWEEP",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/flows/reset-cleanup.ts",
          effects: ["cleanup"],
          owners: [
            {
              effect: "cleanup",
              module: "apps/api/src/lib/flows/reset-cleanup-owner.ts",
              exports: ["cleanupFlowDefinitions"],
            },
          ],
          reason:
            "Reset removes retained feature data and records its own deletion counts in the same transaction without returning feature counts to the generic sweep.",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/member-assignment-offboarding.ts",
          effects: ["cleanup"],
          owners: [
            {
              effect: "cleanup",
              module: "apps/api/src/lib/member-assignment-offboarding-owner.ts",
              exports: [
                "clearMemberAssignments",
                "tryLockMemberCleanupWorkspace",
                "tryLockAccountMemberCleanup",
                "removeOrganizationMemberInTransaction",
              ],
            },
          ],
          reason:
            "Membership removal clears retained flow assignments under the existing ordered locks, without exposing flow rows or derived workspace identities.",
        },
        {
          type: "admitted",
          module:
            "apps/api/src/lib/scheduler/tasks/upload-flow-trigger-recovery.ts",
          admission: "isDeploymentFeatureEnabled",
          specifier: "@/api/lib/deployment-feature",
        },
        {
          type: "registry",
          module: "apps/api/src/lib/feature-access/registry.ts",
          registry: "SELF_SERVE_FEATURE_IDS",
        },
        {
          type: "admitted",
          module: "apps/api/src/mcp/capability-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/flows/visibility.ts",
          admission: "isFeatureEnabled",
          specifier: "@/api/lib/auth/feature-access/policy",
        },
        {
          type: "operational",
          module: "apps/api/src/lib/flows/upload-trigger-recording.ts",
          effects: ["record-recovery"],
          owners: [
            {
              effect: "record-recovery",
              module:
                "apps/api/src/lib/flows/maybe-start-upload-triggered-flows.ts",
              exports: [
                "recordUploadTriggeredFlowIntents",
                "maybeStartUploadTriggeredFlows",
              ],
            },
          ],
          reason:
            "Uploads atomically retain delivery receipts; replay admits the definition author and exposes no flow result to the uploader.",
        },
        ...[
          "apps/api/src/lib/flows/start-automated-flow-run.ts",
          "apps/api/src/lib/flows/flow-run-worker.ts",
          "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        ].map(
          (module) =>
            ({
              type: "admitted",
              module,
              admission: "isBackgroundFeatureEnabled",
              specifier: "@/api/lib/feature-access/background",
            }) as const,
        ),
      ],
    },
  },
  [LIST_VERIFICATION_FEATURE_ID]: {
    enrolment: "invitation",
    ownership: {
      handlerDirectories: [
        "apps/api/src/handlers/lists/verifications",
        "apps/api/src/handlers/lists/items/fact-details",
        "apps/api/src/handlers/lists/items/sources/verification",
      ],
      tableSchemaFiles: ["apps/api/src/db/schema/lists-verification.ts"],
      coreModules: [
        "apps/api/src/lib/lists/verification/access-context.ts",
        "apps/api/src/lib/lists/verification/claim-extract.ts",
        "apps/api/src/lib/lists/verification/claim-grade.ts",
        "apps/api/src/lib/lists/verification/evidence.ts",
        "apps/api/src/lib/lists/verification/model-call.ts",
        "apps/api/src/lib/lists/verification/read-run.ts",
        "apps/api/src/lib/lists/verification/review-fold.ts",
        "apps/api/src/lib/lists/verification/run-persistence.ts",
        "apps/api/src/lib/lists/verification/run-queue.ts",
        "apps/api/src/lib/lists/verification/run-summary.ts",
      ],
      conditionalModules: [
        "apps/api/src/lib/lists/verification/view-layout.ts",
      ],
    },
  },
} as const satisfies FeatureRegistry &
  Record<
    (typeof SELF_SERVE_FEATURE_IDS)[number],
    FeatureDefinition & { enrolment: "self-serve" }
  >;

export type FeatureId = keyof typeof FEATURE_REGISTRY;

export const CHAT_ONLY_FEATURE_TOOL_DEFINITIONS = [
  { name: VISUAL_PREVIEW_TOOL_NAME, featureId: GENERATED_VIEWS_FEATURE_ID },
] as const satisfies readonly { name: string; featureId: FeatureId }[];

type SelfServeFeatureId = {
  [
    Id in FeatureId
  ]: (typeof FEATURE_REGISTRY)[Id]["enrolment"] extends "self-serve"
    ? Id
    : never;
}[FeatureId];

true satisfies Exclude<
  SelfServeFeatureId,
  (typeof SELF_SERVE_FEATURE_IDS)[number]
> extends never
  ? true
  : never;

export const deploymentFeatureFor = (
  featureId: string,
): DeploymentFeatureFlag | undefined => {
  const entry = Object.entries(FEATURE_REGISTRY).find(
    ([id]) => id === featureId,
  );
  if (entry === undefined) {
    return undefined;
  }
  const [, definition] = entry;
  return "deploymentFeature" in definition
    ? definition.deploymentFeature
    : undefined;
};
