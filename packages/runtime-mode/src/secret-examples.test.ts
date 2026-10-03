import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE, secretExampleInvariantViolation } from "./index";
import { SECRET_EXAMPLES } from "./secret-examples.generated";

describe("runtime configuration examples", () => {
  test("accepts local connections and non-credential configuration in strict mode", () => {
    expect(
      secretExampleInvariantViolation({
        values: {
          DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
          REDIS_URL: "redis://localhost:6379",
          INGESTION_USER_AGENT:
            "acme-ingestion/1.0 (+https://example.com/contact)",
          DB_PASSWORD: "",
          SMTP_PASSWORD: "",
          S3_ACCESS_KEY_ID: "stella-rustfs-dev",
        },
        runtimeMode: { mode: RUNTIME_MODE.strict },
      }),
    ).toBeNull();
  });

  test("requires configured values for every credential example in strict mode", () => {
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
