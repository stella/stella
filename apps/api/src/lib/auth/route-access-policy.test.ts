import { expect, test } from "bun:test";
import Elysia from "elysia";

import {
  authMacro,
  permissionMacro,
  sessionAuthMacro,
  workspaceAccessMacro,
} from "../auth";
import { ROUTE_ACCESS_DETAIL } from "./route-access-policy";

test("access declarations survive macro expansion in the mounted registry", () => {
  const app = new Elysia()
    .use(authMacro)
    .use(sessionAuthMacro)
    .use(permissionMacro)
    .use(workspaceAccessMacro)
    .get("/session", () => "fixture", { validateSession: true })
    .get("/organization", () => "fixture", { validateAuth: true })
    .get("/matter/:workspaceId", () => "fixture", {
      validateWorkspaceAccess: true,
      permissions: { workspace: ["read"] },
    })
    .get("/archived/:workspaceId", () => "fixture", {
      validateWorkspaceAccessIncludingArchived: true,
    });
  const details = new Map(
    app.routes.map(({ path, hooks }) => [path, hooks.detail]),
  );
  expect(details.get("/session")).toMatchObject({
    [ROUTE_ACCESS_DETAIL.authentication]: "session",
  });
  expect(details.get("/organization")).toMatchObject({
    [ROUTE_ACCESS_DETAIL.authentication]: "organization",
  });
  expect(details.get("/matter/:workspaceId")).toMatchObject({
    [ROUTE_ACCESS_DETAIL.authentication]: "organization",
    [ROUTE_ACCESS_DETAIL.matter]: "active",
    [ROUTE_ACCESS_DETAIL.permissions]: { workspace: ["read"] },
  });
  expect(details.get("/archived/:workspaceId")).toMatchObject({
    [ROUTE_ACCESS_DETAIL.authentication]: "organization",
    [ROUTE_ACCESS_DETAIL.matter]: "including-archived",
  });
});
