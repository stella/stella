export const MIGRATE_ONLINE_WORK_MODE = {
  VERIFY_FINALIZED: "verify_finalized",
  BUILD_FINALIZED: "build_finalized",
} as const;

export type MigrateOnlineWorkMode =
  (typeof MIGRATE_ONLINE_WORK_MODE)[keyof typeof MIGRATE_ONLINE_WORK_MODE];

export const MIGRATE_ONLINE_WORK_MODES = [
  MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED,
  MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED,
] as const satisfies readonly MigrateOnlineWorkMode[];
