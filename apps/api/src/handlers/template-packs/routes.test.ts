import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { envApiServerSchema } from "@/api/env-schema";
import getTemplatePack from "@/api/handlers/template-packs/get";
import { templatePacksRoute } from "@/api/handlers/template-packs/routes";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const withGate = async (enabled: boolean, request: Request) => {
  const previous = env.FEATURE_TEMPLATE_PACKS;
  env.FEATURE_TEMPLATE_PACKS = enabled;
  try {
    await using server = serveForTest(
      createHttpApp({
        routes: templatePacksRoute,
        middleware: [errorBoundary],
      }),
    );
    return await server.fetch(request);
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

    expect(v.is(schema, { packId: "general-legal" })).toBe(true);
    expect(v.is(schema, { packId: ".." })).toBe(false);
    expect(v.is(schema, { packId: "../etc" })).toBe(false);
    expect(v.is(schema, { packId: "packs/general-legal" })).toBe(false);
    expect(v.is(schema, { packId: "General-Legal" })).toBe(false);
    expect(v.is(schema, { packId: "" })).toBe(false);
  });
});
