import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { readFileSync } from "node:fs";

import {
  AUTH_REJECTION_BODY,
  authMacro,
  permissionMacro,
  sessionAuthMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000000";

const UNAUTHENTICATED_ROUTES = [
  {
    name: "validateSession",
    path: "/protected",
    app: new Elysia()
      .use(sessionAuthMacro)
      .get("/protected", () => ({ ok: true }), { validateSession: true }),
  },
  {
    name: "validateAuth",
    path: "/protected",
    app: new Elysia()
      .use(authMacro)
      .get("/protected", () => ({ ok: true }), { validateAuth: true }),
  },
  {
    name: "permissions",
    path: "/protected",
    app: new Elysia()
      .use(permissionMacro)
      .get("/protected", () => ({ ok: true }), {
        permissions: { workspace: ["read"] },
      }),
  },
  {
    name: "validateWorkspaceAccess",
    path: `/workspaces/${WORKSPACE_ID}`,
    app: new Elysia()
      .use(workspaceAccessMacro)
      .get("/workspaces/:workspaceId", () => ({ ok: true }), {
        validateWorkspaceAccess: true,
      }),
  },
  {
    name: "validateWorkspaceAccessIncludingArchived",
    path: `/workspaces/${WORKSPACE_ID}`,
    app: new Elysia()
      .use(workspaceAccessMacro)
      .get("/workspaces/:workspaceId", () => ({ ok: true }), {
        validateWorkspaceAccessIncludingArchived: true,
      }),
  },
];

describe("auth macro rejections", () => {
  for (const { name, path, app } of UNAUTHENTICATED_ROUTES) {
    test(`${name} answers an anonymous request with a JSON 401`, async () => {
      const response = await app.handle(new Request(`http://localhost${path}`));

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
