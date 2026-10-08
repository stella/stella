import { env } from "@/api/env";

// oxlint-disable-next-line no-direct-test-state/no-direct-test-state -- fixture: environment mutation must be reported
process.env["STELLA_TEST_STATE_FIXTURE"] = "test";

// oxlint-disable-next-line no-direct-test-state/no-direct-test-state -- fixture: validated configuration mutation must be reported
env.AI_PROVIDER = "openai";

// expect-clean: no-direct-test-state/no-direct-test-state
const provider = env.AI_PROVIDER;
void provider;
