import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUTH_REJECTION_BODY } from "@/api/lib/auth";
import { defineEndpoint } from "@/api/lib/endpoints";
import { serveForTest } from "@/api/tests/helpers/test-server";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000000";

const permissionConfig = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "dev_only" },
} satisfies HandlerConfig;

const permissionRoute = createSafeRootHandler(
  permissionConfig,
  async function* () {
    return Result.ok({ ok: true });
  },
);

const archivedWorkspaceRoute = createSafeHandler(
  { ...permissionConfig, workspaceStatus: "active-or-archived" },
  async function* () {
    return Result.ok({ ok: true });
  },
);

const server = serveForTest(
  createHttpApp({
    middleware: [],
    routes: [
      ...routes(
        {
          "/protected": {
            GET: defineEndpoint.session({}, () => ({ ok: true })),
          },
        },
        { prefix: "/session" },
      ),
      ...routes(
        {
          "/protected": {
            GET: defineEndpoint.member({}, () => ({ ok: true })),
          },
        },
        { prefix: "/member" },
      ),
      ...routes(
        { "/protected": { GET: permissionRoute } },
        { prefix: "/permissions" },
      ),
      ...routes(
        {
          "/workspaces/:workspaceId": {
            GET: defineEndpoint.workspace({}, () => ({ ok: true })),
          },
        },
        { prefix: "/workspace" },
      ),
      ...routes(
        { "/workspaces/:workspaceId": { GET: archivedWorkspaceRoute } },
        { prefix: "/workspace-archived" },
      ),
    ],
  }),
);

afterAll(async () => {
  await server.stop();
});

const UNAUTHENTICATED_ROUTES = [
  { name: "session endpoint", path: "/session/protected" },
  { name: "member endpoint", path: "/member/protected" },
  { name: "permission-gated safe handler", path: "/permissions/protected" },
  {
    name: "workspace endpoint",
    path: `/workspace/workspaces/${WORKSPACE_ID}`,
  },
  {
    name: "workspace handler admitting archived matters",
    path: `/workspace-archived/workspaces/${WORKSPACE_ID}`,
  },
];

describe("access rejections", () => {
  for (const { name, path } of UNAUTHENTICATED_ROUTES) {
    test(`${name} answers an anonymous request with a JSON 401`, async () => {
      const response = await server.fetch(`http://localhost${path}`);

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toStartWith(
        "application/json",
      );
      expect(await response.json()).toEqual(AUTH_REJECTION_BODY[401]);
    });
  }

  // The 403, 404 and 500 branches need a signed-in member or a failing auth
  // backend; this guard keeps every branch in the module on a JSON body.
  test("auth.ts never answers with a bodiless status", () => {
    const source = readFileSync(new URL("auth.ts", import.meta.url), "utf-8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join("\n");

    expect(code.match(/\bstatus\(\s*[^,()]+\)/gu) ?? []).toEqual([]);
  });
});
