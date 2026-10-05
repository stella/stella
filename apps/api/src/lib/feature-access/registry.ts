import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";

type FeatureDefinition = {
  enrolment: "invitation" | "self-serve";
  deploymentFeature?: DeploymentFeatureFlag;
  ownership?: {
    handlerDirectories: readonly string[];
    tableSchemaFiles: readonly string[];
    coreModules: readonly string[];
    conditionalModules?: readonly string[];
  };
};

export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;

export const SELF_SERVE_FEATURE_IDS = ["time-billing"] as const;

export const FEATURE_REGISTRY = {
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
    },
  },
} as const satisfies Record<
  (typeof SELF_SERVE_FEATURE_IDS)[number],
  FeatureDefinition & { enrolment: "self-serve" }
>;

export type FeatureId = keyof typeof FEATURE_REGISTRY;
