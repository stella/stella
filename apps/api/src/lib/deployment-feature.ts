import { panic } from "better-result";

import { env } from "@/api/env";
import { isLocalDevOpen } from "@/api/runtime-mode";

/**
 * A deployment feature flag: a `FEATURE_*` key of the API env schema, so a
 * typo or a removed flag fails typecheck.
 */
export type DeploymentFeatureFlag = Extract<
  keyof typeof env,
  `FEATURE_${string}`
>;

const LOCAL_DEV_ACCESS = {
  /** Local development serves the feature whatever the flag says. */
  open: "open",
  /** The flag decides in every runtime mode. */
  followsFlag: "follows-flag",
} as const;

type LocalDevAccess = (typeof LOCAL_DEV_ACCESS)[keyof typeof LOCAL_DEV_ACCESS];

/**
 * How each flag reads while local development access is open. Opened flags
 * gate surfaces local work must reach (routes, agent tools); the rest gate
 * effects local development opts into explicitly (storage accounting,
 * admission, billing, external providers). A new flag cannot land without a
 * decision here.
 */
const LOCAL_DEV_ACCESS_BY_FLAG = {
  FEATURE_ACTION_ADMISSION: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_ACTION_COST_RECORDS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_AGENT_ID_JAG: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_AI_MEMORY: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_CONFIGURED_ACCESS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_FLOWS: LOCAL_DEV_ACCESS.open,
  FEATURE_FILE_USAGE_LIMITS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_GOVERNED_WORKFLOW: LOCAL_DEV_ACCESS.open,
  FEATURE_GENERATED_VIEWS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_INBOX_DOCUMENT_SCOUTS: LOCAL_DEV_ACCESS.open,
  FEATURE_LEGAL_LISTS: LOCAL_DEV_ACCESS.open,
  FEATURE_MANAGED_PROVIDER_CHECKS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_MCP_READ_FENCE: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_ORG_ACCESS_STATE: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_ORG_SERVICE_BUDGETS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_PUBLIC_KNOWLEDGE: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_PUBLIC_LAW: LOCAL_DEV_ACCESS.open,
  FEATURE_PUBLIC_TOOLS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_SIGNALS: LOCAL_DEV_ACCESS.open,
  FEATURE_SHAREPOINT: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_TEMPLATE_PACKS: LOCAL_DEV_ACCESS.followsFlag,
  FEATURE_TIME_BILLING: LOCAL_DEV_ACCESS.open,
  FEATURE_USAGE: LOCAL_DEV_ACCESS.open,
  FEATURE_WEB_SEARCH: LOCAL_DEV_ACCESS.followsFlag,
} as const satisfies Record<DeploymentFeatureFlag, LocalDevAccess>;

/**
 * Whether a deployment feature is on. Every API read of a `FEATURE_*` flag
 * goes through here (enforced by `deployment-feature-flags`), so a route gate,
 * an agent tool and an in-handler default cannot disagree about one flag.
 * Reads per call: runtime mode and env are resolved when the caller asks.
 */
export const isDeploymentFeatureEnabled = (
  flag: DeploymentFeatureFlag,
): boolean => {
  const access = LOCAL_DEV_ACCESS_BY_FLAG[flag];
  switch (access) {
    case LOCAL_DEV_ACCESS.open:
      return isLocalDevOpen() || env[flag];
    case LOCAL_DEV_ACCESS.followsFlag:
      return env[flag];
    default:
      access satisfies never;
      return panic(`Unknown local development access for ${flag}`);
  }
};

/** Narrow a generated catalog flag before consulting the deployment owner. */
export const isDeploymentFeatureFlag = (
  flag: string,
): flag is DeploymentFeatureFlag =>
  Object.hasOwn(LOCAL_DEV_ACCESS_BY_FLAG, flag);
