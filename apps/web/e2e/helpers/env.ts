export const e2eEnv = {
  get routeSmokeRunId() {
    return process.env["E2E_ROUTE_SMOKE_RUN_ID"];
  },
  get webOrigin() {
    return new URL(process.env["E2E_WEB_URL"] ?? "http://localhost:3000")
      .origin;
  },
  get seedEnvironment() {
    return { ...process.env, NODE_ENV: "development", STELLA_LOCAL_DEV: "1" };
  },
};
