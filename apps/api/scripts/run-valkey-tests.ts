import path from "node:path";

import { loadTestEnv } from "./load-test-env";
import { runGatedTests } from "./run-gated-tests";

loadTestEnv(path.resolve(import.meta.dir, "../.env.test"));

process.exitCode = await runGatedTests({
  requiredEnv: ["REDIS_URL"],
  script: "test:valkey",
});
