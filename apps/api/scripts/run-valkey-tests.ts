import { runGatedTests } from "./run-gated-tests";

process.exitCode = await runGatedTests({
  requiredEnv: ["REDIS_URL"],
  script: "test:valkey",
});
