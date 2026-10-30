// parser-output-unchanged: registering desktop activity access leaves existing ingestion features and parsed records unchanged.
// parser-output-unchanged: assigning the sample case handlers to list verification leaves parsed records unchanged.
// parser-output-unchanged: assigning the client invoice handlers to time billing leaves parsed records unchanged.
// parser-output-unchanged: registering AI memory access leaves ingestion features and parsed records unchanged.
// parser-output-unchanged: registering desktop local agent access leaves ingestion features and parsed records unchanged.
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import { defineFeatureRegistry } from "@/api/lib/feature-access/prerequisites";

type FeatureDefinition = {
  // parser-output-unchanged: enrolment kinds gate access only, never parsed decision output
  enrolment: "invitation" | "self-serve" | "general-availability";
  deploymentFeature?: DeploymentFeatureFlag;
  grantScope?: "organization";
  prerequisites?: readonly string[];
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

export const AI_MEMORY_FEATURE_ID = "ai-memory";
export const REMEMBER_TOOL_NAME = "remember";

export const LEGAL_LISTS_FEATURE_ID = "legal-lists";

export const SELF_SERVE_FEATURE_IDS = ["time-billing"] as const;
export const LIST_VERIFICATION_FEATURE_ID = "list-verification";
export const GENERATED_VIEWS_FEATURE_ID = "generated-views";

export const FEATURE_REGISTRY = defineFeatureRegistry({
  [AI_MEMORY_FEATURE_ID]: {
    enrolment: "invitation",
    deploymentFeature: "FEATURE_AI_MEMORY",
    ownership: {
      handlerDirectories: ["apps/api/src/handlers/memories"],
      tableSchemaFiles: [],
      coreModules: [
        "apps/api/src/lib/memory/persist-explicit-memory.ts",
        "apps/api/src/handlers/chat/tools/remember-tool.ts",
        "apps/api/src/handlers/chat/memory-context.ts",
      ],
      dispatchModules: [
        {
          type: "admitted",
          module: "apps/api/src/handlers/chat/tools/chat-tools.ts",
          admission: "isMcpDescriptorFeatureEnabled",
        },
        {
          type: "admitted",
          module: "apps/api/src/handlers/chat/chat-prompt.ts",
          admission: "buildMemoryPromptParts",
          specifier: "@/api/handlers/chat/memory-context",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/scheduler/tasks/memory-curator.ts",
          admission: "isFeatureDeployed",
          specifier: "@/api/lib/feature-access/deployment",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
          admission: "resolveFeatureAccess",
          specifier: "@/api/lib/auth/feature-access/context",
        },
        {
          type: "admitted",
          module: "apps/api/src/lib/scheduler/jobs.ts",
          admission: "isFeatureDeployed",
          specifier: "@/api/lib/feature-access/deployment",
        },
      ],
    },
  },
  [LEGAL_LISTS_FEATURE_ID]: {
    enrolment: "invitation",
    deploymentFeature: "FEATURE_LEGAL_LISTS",
    ownership: {
      handlerDirectories: ["apps/api/src/handlers/lists"],
      tableSchemaFiles: [],
      coreModules: [],
    },
  },

  // The desktop client gates this feature from its desktop feature access
  // decision; no API source belongs to it.
  "activity-timeline": {
    enrolment: "invitation",
  },
  // Desktop-gated like the timeline: the desktop installs and runs agent
  // CLIs only while this decision is enabled.
  "local-agents": {
    enrolment: "invitation",
  },
  [GENERATED_VIEWS_FEATURE_ID]: {
    enrolment: "general-availability",
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
  "invoice-links": {
    enrolment: "invitation",
    grantScope: "organization",
    deploymentFeature: "FEATURE_INVOICE_LINKS",
    prerequisites: ["time-billing"],
    ownership: {
      handlerDirectories: ["apps/api/src/handlers/invoices/sends"],
      tableSchemaFiles: ["apps/api/src/db/schema/invoice-sends.ts"],
      coreModules: [
        "apps/api/src/lib/billing/invoice-links.ts",
        "apps/api/src/lib/billing/invoice-send-delivery.ts",
      ],
      dispatchModules: [
        // Shared lock infrastructure checks invoice scope; callers own feature admission.
        {
          type: "admitted",
          module: "apps/api/src/lib/db/aggregate-lock.ts",
          admission: "invoiceInMatter",
          specifier: "@/api/lib/billing/invoice-scope",
        },
        // Database and lifecycle registries describe metadata; they do not read tenant data.
        {
          type: "registry",
          module: "apps/api/src/db/database-relations.ts",
          registry: "databaseRelations",
        },
        {
          type: "registry",
          module: "apps/api/src/lib/db/transition-specs.ts",
          registry: "TRANSITIONS",
        },
        // Token handlers admit the token's organization through their verifier.
        ...["view", "download"].map((name) => ({
          type: "admitted" as const,
          module: `apps/api/src/handlers/invoice-links/${name}.ts`,
          admission: "verifyInvoiceLinkCaller",
          specifier: "@/api/handlers/invoice-links/link-access",
        })),
        // Lifecycle transitions withdraw authority even without a feature grant.
        {
          type: "admitted",
          module: "apps/api/src/lib/db/transitions.ts",
          admission: "revokeInvoiceLinksAfterTransition",
          specifier: "@/api/lib/billing/invoice-send-revocation",
        },
        {
          type: "admitted",
          module: "apps/api/src/handlers/invoice-links/link-access.ts",
          admission: "isOrganizationFeatureEnabled",
          specifier: "@/api/lib/feature-access/organization",
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
        "apps/api/src/handlers/client-invoices",
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
  [LIST_VERIFICATION_FEATURE_ID]: {
    prerequisites: [LEGAL_LISTS_FEATURE_ID],
    enrolment: "invitation",
    ownership: {
      handlerDirectories: [
        "apps/api/src/handlers/lists/verifications",
        "apps/api/src/handlers/lists/sample-case",
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
  >);

export type FeatureId = keyof typeof FEATURE_REGISTRY;

export const CHAT_ONLY_FEATURE_TOOL_DEFINITIONS = [
  { name: REMEMBER_TOOL_NAME, featureId: AI_MEMORY_FEATURE_ID },
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

true satisfies Exclude<DesktopFeatureId, FeatureId> extends never
  ? true
  : never;
