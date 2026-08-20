import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { envApiServerSchema } from "@/api/env-schema";
import getTemplatePack from "@/api/handlers/template-packs/get";
import { templatePacksRoute } from "@/api/handlers/template-packs/routes";

const withGate = async (enabled: boolean, request: Request) => {
  const previous = env.FEATURE_TEMPLATE_PACKS;
  env.FEATURE_TEMPLATE_PACKS = enabled;
  try {
    return await templatePacksRoute.handle(request);
  } finally {
    env.FEATURE_TEMPLATE_PACKS = previous;
  }
};

describe("template pack routes", () => {
  test("a deployment that does not offer packs has no such routes", async () => {
    const response = await withGate(
      false,
      new Request("http://localhost/template-packs"),
    );

    expect(response.status).toBe(404);
  });

  test("the gate is off until a deployment opts in", () => {
    // Not a literal restated from the schema: the flag has to agree with the
    // launch-flag block it sits in, so it moves only when that convention does.
    expect(v.parse(envApiServerSchema.FEATURE_TEMPLATE_PACKS, undefined)).toBe(
      false,
    );
    expect(v.parse(envApiServerSchema.FEATURE_TEMPLATE_PACKS, undefined)).toBe(
      v.parse(envApiServerSchema.FEATURE_PUBLIC_LAW, undefined),
    );
  });

  test("the gate runs before authentication, so enabling it restores the 401", async () => {
    const response = await withGate(
      true,
      new Request("http://localhost/template-packs"),
    );

    expect(response.status).toBe(401);
  });
});

describe("template pack id", () => {
  // Every pack route takes the id from the path and the loader joins it onto
  // the content root, so the grammar is checked before the handler runs.
  test("accepts the slug grammar and rejects traversal, case and emptiness", () => {
    const schema = getTemplatePack.config.params;

    expect(Value.Check(schema, { packId: "general-legal" })).toBe(true);
    expect(Value.Check(schema, { packId: ".." })).toBe(false);
    expect(Value.Check(schema, { packId: "../etc" })).toBe(false);
    expect(Value.Check(schema, { packId: "packs/general-legal" })).toBe(false);
    expect(Value.Check(schema, { packId: "General-Legal" })).toBe(false);
    expect(Value.Check(schema, { packId: "" })).toBe(false);
  });
});
