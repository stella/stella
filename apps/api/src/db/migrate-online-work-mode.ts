export const MIGRATE_ONLINE_WORK_MODE = {
  VERIFY_FINALIZED: "verify_finalized",
  BUILD_FINALIZED: "build_finalized",
  /**
   * Finalized and pending work alike: only for a fresh database compared
   * with the declared schema, which already declares the pending work.
   */
  BUILD_ALL: "build_all",
} as const;

export type MigrateOnlineWorkMode =
  (typeof MIGRATE_ONLINE_WORK_MODE)[keyof typeof MIGRATE_ONLINE_WORK_MODE];

export const MIGRATE_ONLINE_WORK_MODES = [
  MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED,
  MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED,
  MIGRATE_ONLINE_WORK_MODE.BUILD_ALL,
] as const satisfies readonly MigrateOnlineWorkMode[];
