const DEPLOY_TASK = {
  api: "api",
  documentProcessing: "document-processing",
  caseLawReplay: "case-law-replay",
} as const;

export type DeployTask = (typeof DEPLOY_TASK)[keyof typeof DEPLOY_TASK];

export const DEPLOY_TASK_ADDRESSES = {
  [DEPLOY_TASK.api]: "module.ecs.aws_ecs_task_definition.api",
  [DEPLOY_TASK.documentProcessing]:
    "module.ecs.aws_ecs_task_definition.document_processing",
  [DEPLOY_TASK.caseLawReplay]:
    "module.ecs.aws_ecs_task_definition.case_law_replay",
} as const satisfies Record<DeployTask, string>;

const ALL_TASKS = Object.values(DEPLOY_TASK);

type DeployEnvEntry = {
  readonly name: string;
  readonly tasks: readonly DeployTask[];
  readonly kind: "environment" | "secrets" | "either";
  readonly reason: string;
  readonly readinessField?: "deployEnvironment";
};

export const DEPLOY_ENV_CONTRACT: readonly DeployEnvEntry[] = [
  {
    name: "DEPLOY_ENVIRONMENT",
    tasks: ALL_TASKS,
    kind: "environment",
    reason: "Readiness reports the deployment the task runs in.",
    readinessField: "deployEnvironment",
  },
  {
    name: "OPENROUTER_FAST_TIER_API_KEY",
    tasks: ALL_TASKS,
    kind: "secrets",
    reason:
      "Boot refuses FEATURE_FREE_TIER with AI_PROVIDER=openrouter without a fast-tier credential.",
  },
  {
    name: "DATABASE_URL",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Database connection is required at boot.",
  },
  {
    name: "S3_ENDPOINT",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Object storage endpoint is required at boot.",
  },
  {
    name: "S3_BUCKET",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Object storage bucket is required at boot.",
  },
  {
    name: "S3_REGION",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Object storage region is required at boot.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Session signing configuration is required at boot.",
  },
  {
    name: "BETTER_AUTH_URL",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Session issuer configuration is required at boot.",
  },
  {
    name: "FRONTEND_URL",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Frontend origin is required at boot.",
  },
  {
    name: "GOTENBERG_URL",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Document conversion endpoint is required at boot.",
  },
  {
    name: "GOTENBERG_USERNAME",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Document conversion authentication is required at boot.",
  },
  {
    name: "GOTENBERG_PASSWORD",
    tasks: ALL_TASKS,
    kind: "either",
    reason: "Document conversion authentication is required at boot.",
  },
];
