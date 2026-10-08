import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";

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
    )[];
  };
};

export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;

export const SELF_SERVE_FEATURE_IDS = [
  "time-billing",
  "signals",
  "flows",
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
  signals: {
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
          type: "registry",
          module: "apps/api/src/lib/feature-access/registry.ts",
          registry: "SELF_SERVE_FEATURE_IDS",
        },
        {
          type: "admitted",
          module: "apps/api/src/mcp/capability-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        ...[
          "apps/api/src/lib/scouts/document-deadlines.ts",
          "apps/api/src/lib/scouts/document-review.ts",
          "apps/api/src/lib/scouts/infosoud-hearings.ts",
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
  flows: {
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
          type: "registry",
          module: "apps/api/src/lib/feature-access/registry.ts",
          registry: "SELF_SERVE_FEATURE_IDS",
        },
        {
          type: "admitted",
          module: "apps/api/src/mcp/capability-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        ...[
          "apps/api/src/lib/flows/start-automated-flow-run.ts",
          "apps/api/src/lib/flows/flow-run-worker.ts",
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
  const definition = Object.entries(FEATURE_REGISTRY)
    .find(([id]) => id === featureId)
    ?.at(1);
  return definition !== undefined && "deploymentFeature" in definition
    ? definition.deploymentFeature
    : undefined;
};
