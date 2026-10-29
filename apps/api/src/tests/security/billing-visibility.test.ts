import { Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { moneySchema } from "@stll/api-contract/billing-money";
import {
  BILLING_MATTER_READ_PERMISSION,
  BILLING_READ_PERMISSION,
  memberHasPermissions,
  roles,
  withBillingRead,
} from "@stll/permissions";

import listExpenses from "@/api/handlers/expenses/list";
import type { RouteEntry } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  getSafeHandlerAccessMetadata,
} from "@/api/lib/api-handlers";
import { moneyPaths } from "@/api/lib/billing/money-response";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { finalizeToolEgress } from "@/api/mcp/egress";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { hasMcpToolAuthority } from "@/api/mcp/write-tool-authority";
import { apiApp } from "@/api/server";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const carriesBillingRead = (permissions: unknown) =>
  isRecord(permissions) &&
  Array.isArray(permissions["billing"]) &&
  permissions["billing"].includes("read");

const carriesMoneyRead = (permissions: unknown) =>
  isRecord(permissions) &&
  Array.isArray(permissions["billing"]) &&
  permissions["billing"].includes("read") &&
  Array.isArray(permissions["workspace"]) &&
  permissions["workspace"].includes("read");

const monetaryRouteOffenders = (routes: readonly RouteEntry[]) =>
  routes
    .filter(({ definition }) => {
      const paths = moneyPaths(definition.config["moneyResponse"]);
      if (
        carriesBillingRead(definition.config["permissions"]) &&
        !carriesMoneyRead(definition.config["permissions"])
      ) {
        return true;
      }
      if (paths.length === 0) {
        return false;
      }
      const metadata = getSafeHandlerAccessMetadata(
        "handler" in definition ? definition.handler : undefined,
      );
      if (
        (definition.access !== "member" && definition.access !== "workspace") ||
        !metadata
      ) {
        return true;
      }
      return (
        paths.some(({ nullable }) => !nullable) &&
        (!carriesMoneyRead(definition.config["permissions"]) ||
          !carriesMoneyRead(metadata.permissions))
      );
    })
    .map(({ method, path }) => `${method} ${path}`);

test("every mounted Money response, including financial exports, is bound to billing authority", () => {
  const measured = apiApp.routes.filter(
    ({ definition }) =>
      moneyPaths(definition.config["moneyResponse"]).length > 0,
  );
  expect(measured.length).toBeGreaterThan(20);
  expect(monetaryRouteOffenders(apiApp.routes)).toEqual([]);
});

test("a new route with renamed nested Money fails the census without the billing grant", () => {
  const original = apiApp.routes.find(
    ({ definition }) => definition === listExpenses,
  );
  expect(original).toBeDefined();
  if (!original) {
    return;
  }
  const mutation = {
    ...original,
    path: "/unrelated/new-operation",
    definition: {
      ...original.definition,
      config: {
        ...original.definition.config,
        permissions: { workspace: ["read"] },
        moneyResponse: v.looseObject({
          renamed: v.array(v.looseObject({ value: moneySchema })),
        }),
      },
    },
  };
  expect(moneyPaths(mutation.definition.config.moneyResponse)).toEqual([
    { path: ["renamed", "[]", "value"], nullable: false },
  ]);
  expect(monetaryRouteOffenders([mutation])).toEqual([
    `${mutation.method} /unrelated/new-operation`,
  ]);
  const fixed = {
    ...mutation,
    definition: {
      ...mutation.definition,
      config: {
        ...mutation.definition.config,
        permissions: BILLING_MATTER_READ_PERMISSION,
      },
    },
  };
  expect(monetaryRouteOffenders([fixed])).toEqual([]);
  const billingOnly = {
    ...fixed,
    definition: {
      ...fixed.definition,
      config: {
        ...fixed.definition.config,
        permissions: BILLING_READ_PERMISSION,
      },
    },
  };
  expect(monetaryRouteOffenders([billingOnly])).toEqual([
    `${billingOnly.method} /unrelated/new-operation`,
  ]);
});

test("native Money schemas bind the same authority in normal and anonymized modes", () => {
  const measured: string[] = [];
  for (const definitions of [
    DEFAULT_MCP_TOOL_DEFINITIONS,
    ANONYMIZED_MCP_TOOL_DEFINITIONS,
  ]) {
    for (const definition of definitions) {
      const contract = getStaticMcpToolOutputContract(definition.name);
      expect(contract, definition.name).toBeDefined();
      const paths = moneyPaths(contract?.outputSchemaSource);
      if (
        definition.permissions.type === "all" &&
        carriesBillingRead(definition.permissions.permissions)
      ) {
        expect(
          carriesMoneyRead(definition.permissions.permissions),
          definition.name,
        ).toBe(true);
      }
      if (paths.length === 0) {
        continue;
      }
      measured.push(definition.name);
      if (paths.every(({ nullable }) => nullable)) {
        continue;
      }
      expect(definition.permissions.type, definition.name).toBe("all");
      if (definition.permissions.type === "all") {
        expect(
          carriesMoneyRead(definition.permissions.permissions),
          definition.name,
        ).toBe(true);
      }
    }
  }
  expect(measured).toContain("list_invoices");
  expect(measured).toContain("resolve_rate");
  expect(measured).toContain("list_time_entries");
});

test("money visibility is an additional member grant and does not replace operation grants", () => {
  for (const [role, grant] of Object.entries(roles)) {
    expect(grant.authorize({ workspace: ["read"] }).success, role).toBe(true);
    expect(grant.authorize(BILLING_READ_PERMISSION).success, role).toBe(
      role === "owner" || role === "admin",
    );
  }
  expect(
    memberHasPermissions({
      role: "member",
      billingAccess: true,
      permissions: BILLING_READ_PERMISSION,
    }),
  ).toBe(true);
  expect(
    memberHasPermissions({
      role: "member",
      billingAccess: false,
      permissions: BILLING_READ_PERMISSION,
    }),
  ).toBe(false);
  expect(
    memberHasPermissions({
      role: "member",
      billingAccess: false,
      permissions: { invoice: ["create"], expense: ["create"] },
    }),
  ).toBe(true);
  expect(
    memberHasPermissions({
      role: "member",
      billingAccess: true,
      permissions: { rate: ["update"] },
    }),
  ).toBe(false);
});

test("the shared handler boundary refuses non-null Money for an ungranted reader", async () => {
  const endpoint = createSafeRootHandler(
    {
      contract: "patch",
      permissions: { workspace: ["read"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      access: "read",
      description: "Read a monetary test fixture.",
      mcp: {
        type: "capability",
        reason: "billing_admin",
        consumesServices: false,
        readClass: "tenant",
      },
      moneyResponse: v.looseObject({ renamed: v.nullable(moneySchema) }),
    },
    async function* () {
      return Result.ok({ renamed: 123 });
    },
  );
  const context = createTestHandlerContext({
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    memberRole: sessionMemberRole("member"),
    body: {},
    params: {},
    query: {},
  });
  expect(await endpoint.handler(asTestRaw(context))).toMatchObject({
    code: 403,
  });
  expect(
    await endpoint.handler(
      asTestRaw({ ...context, memberRole: sessionMemberRole("member", true) }),
    ),
  ).toEqual({ renamed: 123 });
});

test("MCP and AI egress enforce Money schemas identically in normal and anonymized modes", async () => {
  const outputSchema = v.object({ renamed: v.nullable(moneySchema) });
  for (const mode of ["default", "anonymized"] as const) {
    for (const billingAccess of [false, true]) {
      const context = asTestRaw<
        Parameters<typeof finalizeToolEgress>[0]["context"]
      >({ memberRole: "member", billingAccess });
      const amount = await finalizeToolEgress({
        context,
        mode,
        outputSchema,
        response: { status: "success", data: { renamed: 123 } },
      });
      expect(amount).toEqual(
        billingAccess
          ? { status: "success", data: { renamed: 123 } }
          : {
              status: "error",
              error: {
                type: "structured",
                code: "permission_denied",
                message: "Forbidden",
              },
            },
      );
      expect(
        await finalizeToolEgress({
          context,
          mode,
          outputSchema,
          response: { status: "success", data: { renamed: null } },
        }),
      ).toEqual({ status: "success", data: { renamed: null } });
    }
  }
});

test("money permissions preserve operation grants and require both credential reads", async () => {
  const permissions = withBillingRead({
    invoice: ["update"],
    workspace: ["update"],
  });
  expect(permissions).toEqual({
    invoice: ["update"],
    workspace: ["read", "update"],
    billing: ["read"],
  });
  const credentialPermissions = BILLING_READ_PERMISSION;
  const context = asTestRaw<
    Parameters<typeof BILLING_TOOL_HANDLERS.list_invoices>[0]["context"]
  >({ memberRole: "owner", credentialPermissions });
  const definition = DEFAULT_MCP_TOOL_DEFINITIONS.find(
    ({ name }) => name === "list_invoices",
  );
  expect(definition).toBeDefined();
  if (!definition) {
    return;
  }
  expect(hasMcpToolAuthority(context, definition)).toBe(false);
  expect(
    hasMcpToolAuthority(
      { ...context, credentialPermissions: BILLING_MATTER_READ_PERMISSION },
      definition,
    ),
  ).toBe(true);
  for (const args of [
    { matter_id: "00000000-0000-4000-8000-000000000001" },
    { invoice_id: "00000000-0000-4000-8000-000000000002" },
  ]) {
    expect(
      await BILLING_TOOL_HANDLERS.list_invoices({ context, args }),
    ).toEqual({
      status: "error",
      error: { type: "text", message: "Forbidden" },
    });
  }
  const rest = createTestHandlerContext({
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    memberRole: authorizedMemberRole({
      role: "owner",
      credential: { type: "attenuated", permissions: credentialPermissions },
    }),
    body: {},
    params: {},
    query: {},
  });
  expect(await listExpenses.handler(asTestRaw(rest))).toMatchObject({
    code: 403,
  });
  for (const mode of ["default", "anonymized"] as const) {
    expect(
      await finalizeToolEgress({
        context,
        mode,
        outputSchema: v.object({ amount: moneySchema }),
        response: { status: "success", data: { amount: 123 } },
      }),
    ).toMatchObject({ status: "error" });
  }
});
