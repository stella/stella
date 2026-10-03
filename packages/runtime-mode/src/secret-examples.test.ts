import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE, secretExampleInvariantViolation } from "./index";
import { SECRET_EXAMPLES } from "./secret-examples.generated";

describe("runtime configuration examples", () => {
  test("requires configured values for every secret example in strict mode", () => {
    expect(Object.keys(SECRET_EXAMPLES).length).toBeGreaterThan(0);
    for (const [name, example] of Object.entries(SECRET_EXAMPLES)) {
      const values = { [name]: example };
      const strict = secretExampleInvariantViolation({
        values,
        runtimeMode: { mode: RUNTIME_MODE.strict },
      });
      expect(strict).toContain(name);
      expect(
        secretExampleInvariantViolation({
          values,
          runtimeMode: { mode: RUNTIME_MODE.open },
        }),
      ).toBeNull();
      expect(
        secretExampleInvariantViolation({
          values: { [name]: `${example}-configured` },
          runtimeMode: { mode: RUNTIME_MODE.strict },
        }),
      ).toBeNull();
    }
  });
});
