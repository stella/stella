import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { envBaseServerSchema } from "@/api/env-base-schema";

import { CASE_LAW_DERIVED_AI_MODES } from "./derived-ai-mode";

describe("the case-law derived AI setting", () => {
  // Unset is the local, seeded and CI configuration: it must be the one that
  // never reaches a model. Only an explicit "on" opts a deployment in.
  test("defaults off, accepts each mode and refuses anything else", () => {
    const schema = envBaseServerSchema.CASE_LAW_DERIVED_AI;
    expect(v.parse(schema, undefined)).toBe("off");
    for (const mode of CASE_LAW_DERIVED_AI_MODES) {
      expect(v.parse(schema, mode)).toBe(mode);
    }
    for (const other of ["true", "1", "ON", ""]) {
      expect(v.safeParse(schema, other).success).toBe(false);
    }
  });
});
