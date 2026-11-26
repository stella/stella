export const e2eEnv = {
  get routeSmokeRunId() {
    return process.env["E2E_ROUTE_SMOKE_RUN_ID"];
  },
  get webOrigin() {
    return new URL(process.env["E2E_WEB_URL"] ?? "http://localhost:3000")
      .origin;
  },
  /** `off`, `report` or `enforce`: see ./storm-watch.ts. */
  get stormWatch() {
    return process.env["STELLA_STORM_WATCH"];
  },
  get seedEnvironment() {
    return { ...process.env, NODE_ENV: "development", STELLA_LOCAL_DEV: "1" };
  },
};
