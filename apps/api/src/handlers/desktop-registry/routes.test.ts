import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import grant from "@/api/handlers/desktop-registry/grant";
import request, {
  desktopRequestAuthorization,
} from "@/api/handlers/desktop-registry/request";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { createDesktopEditHandoff } from "@/api/handlers/entities/desktop-edit-handoffs";
import createPdfSigningHandoff from "@/api/handlers/entities/pdf-signing-handoffs";
import {
  authorizeDesktopAccount,
  authorizeDesktopRegistry,
} from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_PERMISSION,
} from "@/api/lib/business-registries/desktop/config";
import {
  DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX,
  DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE,
  DESKTOP_REGISTRY_REQUEST_PATH,
  DESKTOP_REGISTRY_REQUEST_USER_AGENT,
  DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE,
  desktopRegistryNativeRequestHeaders,
  desktopRegistryRequestBody,
  desktopRegistryRequestHeaders,
} from "@/api/lib/business-registries/desktop/request-contract";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";

const FORMAT_ID = "11111111-1111-4111-8111-111111111111";

test("registering desktop routes preserves the grant authorization contract", () => {
  desktopRegistryRoute.compile();

  expect(grant.config.permissions).toEqual(DESKTOP_ACCOUNT_PERMISSION);
  expect(
    hasMemberPermission(sessionMemberRole("owner"), grant.config.permissions),
  ).toBe(true);
});

describe("the desktop request body union", () => {
  test("binds the public route and native headers to the owning contract", () => {
    expect(DESKTOP_REGISTRY_REQUEST_PATH).toBe("/v1/desktop-registry/request");
    const route = desktopRegistryRoute.routes.find(
      ({ method, path }) =>
        method === "POST" && path === "/desktop-registry/request",
    );
    expect(route?.hooks.body).toBe(desktopRegistryRequestBody);
    expect(route?.hooks.headers).toBe(desktopRegistryRequestHeaders);
    expect(request.config.body).toBe(desktopRegistryRequestBody);
    expect(
      Value.Check(desktopRegistryNativeRequestHeaders, {
        authorization: `${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}transport_smoke`,
        "content-type": DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE,
        "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT,
      }),
    ).toBe(true);
    expect(
      Value.Check(desktopRegistryNativeRequestHeaders, {
        authorization: `${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}transport_smoke`,
        "content-type": `${DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE}; charset=utf-8`,
        "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT,
      }),
    ).toBe(false);
  });

  test("accepts JSON media-type parameters before authentication", async () => {
    const response = await desktopRegistryRoute.handle(
      new Request("http://localhost/desktop-registry/request", {
        method: "POST",
        headers: {
          authorization: `${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}unknown`,
          "content-type": "application/json; charset=utf-8",
          "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT,
        },
        body: JSON.stringify({ type: "config" }),
      }),
    );

    expect(response.status).toBe(
      DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.status,
    );
    expect(await response.json()).toEqual(
      DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.body,
    );
  });

  test("accepts each request the desktop sends", () => {
    for (const body of [
      { type: "config" },
      { type: "revoke" },
      { type: "search", registry: "ares", query: "Stella" },
      { type: "format", registry: "ares", id: "123", formatId: FORMAT_ID },
      { type: "format", registry: "ares", id: "123", formatId: null },
      { type: "setDefaultFormat", registry: "ares", formatId: FORMAT_ID },
      { type: "setDefaultFormat", registry: "ares", formatId: null },
    ]) {
      expect([body, Value.Check(request.config.body, body)]).toEqual([
        body,
        true,
      ]);
    }
  });

  test("rejects a default-format request the handler could not scope", () => {
    for (const body of [
      { type: "setDefaultFormat", formatId: FORMAT_ID },
      { type: "setDefaultFormat", registry: "not-a-registry", formatId: null },
      { type: "setDefaultFormat", registry: "ares", formatId: "compact" },
      // The saved format is read under the caller's own organization, so an
      // organization the caller names is never a scope the handler accepts.
      {
        type: "setDefaultFormat",
        registry: "ares",
        formatId: FORMAT_ID,
        organizationId: "00000000-0000-4000-8000-000000000001",
      },
    ]) {
      expect([body, Value.Check(request.config.body, body)]).toEqual([
        body,
        false,
      ]);
    }
  });
});

test("desktop account linking preserves document access for each supported role", () => {
  for (const role of [
    "owner",
    "admin",
    "member",
    "intern",
    "external",
  ] as const) {
    expect(
      hasMemberPermission(sessionMemberRole(role), grant.config.permissions),
    ).toBe(true);
    const webWriteAllowed = hasMemberPermission(sessionMemberRole(role), {
      entity: ["update"],
    });
    expect(
      hasMemberPermission(
        sessionMemberRole(role),
        createDesktopEditHandoff.config.permissions,
      ),
    ).toBe(webWriteAllowed);
    expect(
      hasMemberPermission(
        sessionMemberRole(role),
        createPdfSigningHandoff.config.permissions,
      ),
    ).toBe(webWriteAllowed);
    expect(
      canWriteWorkspaceEntities({
        organizationRole: role,
        workspaceMemberId: "member-fixture",
      }),
    ).toBe(webWriteAllowed);
  }
  expect(
    hasMemberPermission(
      sessionMemberRole("external"),
      grant.config.permissions,
    ),
  ).toBe(true);
  expect(
    hasMemberPermission(
      sessionMemberRole("external"),
      DESKTOP_REGISTRY_PERMISSION,
    ),
  ).toBe(false);
});

test("desktop request authorization follows each operation", () => {
  expect(desktopRequestAuthorization.config).toBe(authorizeDesktopAccount);
  expect(desktopRequestAuthorization.revoke).toBe(authorizeDesktopAccount);
  expect(desktopRequestAuthorization.search).toBe(authorizeDesktopRegistry);
  expect(desktopRequestAuthorization.format).toBe(authorizeDesktopRegistry);
  expect(desktopRequestAuthorization.setDefaultFormat).toBe(
    authorizeDesktopRegistry,
  );
});
