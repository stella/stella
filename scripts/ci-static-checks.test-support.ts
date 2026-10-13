import { panic } from "better-result";

import { staticReuseCondition } from "./ci-static-checks";

// Existing workflow contracts own the original check condition; receipt
// eligibility and queue exclusions are exercised against the raw graph.
export const withoutStaticReuseCondition = (step: Record<string, unknown>) => {
  const env = step["env"];
  if (
    typeof env !== "object" ||
    env === null ||
    !("CI_CHECK_KIND" in env) ||
    env.CI_CHECK_KIND !== "STATIC"
  ) {
    return step;
  }
  const id = step["id"];
  const condition = step["if"];
  if (typeof id !== "string" || typeof condition !== "string") {
    panic("Static check condition is incomplete");
  }
  const suffix = `${staticReuseCondition(id)} }}`;
  if (!condition.endsWith(suffix)) {
    panic("Static check receipt condition is not canonical");
  }
  const result = { ...step };
  result["if"] = `${condition.slice(0, -suffix.length)} }}`;
  return result;
};
