import { expect, test } from "bun:test";
import * as v from "valibot";

import { stellaMcpAppBundleSchema } from "@stll/api-contract/stella-mcp-app";
import { readMcpAppBundle } from "@stll/mcp-apps/bundles";
import {
  CASE_LAW_RESULTS_RESOURCE_URI,
  STATUTE_TIMELINE_RESOURCE_URI,
} from "@stll/mcp-apps/resource-uri";

import type { ResponseSet } from "@/api/http/context";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { chatMcpAppBundleScalingScenario } from "@/api/tests/read-scaling/chat-mcp-app-bundle";

import readChatMcpAppBundle from "./read-bundle";

const read = async (app: string) => {
  const set: ResponseSet = { headers: {} };
  const context = createTestHandlerContext<
    Parameters<typeof readChatMcpAppBundle.handler>[0]
  >({
    audit: NO_AUDIT,
    scopedDb: NO_DB,
    safeDb: NO_DB,
    params: { app },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_bundle_test"),
    },
    user: { id: toSafeId<"user">("user_bundle_test") },
    request: new Request("https://example.test/bundle"),
    set,
  });
  return { response: await readChatMcpAppBundle.handler(context), set };
};

test("serves a chat app's own bundle as data the browser keeps briefly", async () => {
  for (const [app, uri] of [
    ["case-law-results", CASE_LAW_RESULTS_RESOURCE_URI],
    ["statute-timeline", STATUTE_TIMELINE_RESOURCE_URI],
  ] as const) {
    const { response, set } = await read(app);
    const bundle = v.parse(stellaMcpAppBundleSchema, response);
    expect(bundle).toEqual({ uri, html: readMcpAppBundle(app) });
    expect(set.cache).toEqual({ kind: "private", maxAge: 300 });
    expect(set.headers["X-Content-Type-Options"]).toBe("nosniff");
  }
});

test("serves no app chat cannot show", async () => {
  for (const app of ["document-upload", "file-comparison", "unknown-app"]) {
    const { response } = await read(app);
    expect(response).toMatchObject({ code: 404 });
  }
});

test("the read touches no database, whatever the member stores", async () => {
  const measured = await chatMcpAppBundleScalingScenario.measure({
    app: "case-law-results",
  });
  expect(measured).toMatchObject({ statements: 0, transactionRoundTrips: 0 });
  expect(measured.responseBytes).toBeGreaterThan(
    readMcpAppBundle("case-law-results").length,
  );
});
