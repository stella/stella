import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { statements } from "@stll/permissions";

import { env } from "@/api/env";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import type { AccountAccess } from "@/api/lib/api-handlers";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import { discoverSafeHandlers } from "../../../scripts/lib/enumerate-safe-handlers";

const configSchema = v.object({
  permissions: v.optional(v.record(v.string(), v.array(v.string()))),
  accountAccess: v.picklist(Object.values(ACCOUNT_ACCESS)),
});

// The least access a handler may declare when it grants a non-read action on
// the resource: organization administration stays with standard accounts.
const RESOURCE_WRITE_ACCOUNT_ACCESS = {
  organization: ACCOUNT_ACCESS.standard,
  member: ACCOUNT_ACCESS.standard,
  invitation: ACCOUNT_ACCESS.standard,
  team: ACCOUNT_ACCESS.standard,
  ac: ACCOUNT_ACCESS.standard,
  workspace: ACCOUNT_ACCESS.sandbox,
  organizationSettings: ACCOUNT_ACCESS.standard,
  integration: ACCOUNT_ACCESS.standard,
  contact: ACCOUNT_ACCESS.sandbox,
  invoice: ACCOUNT_ACCESS.sandbox,
  template: ACCOUNT_ACCESS.sandbox,
  styleSet: ACCOUNT_ACCESS.sandbox,
  clause: ACCOUNT_ACCESS.sandbox,
  entity: ACCOUNT_ACCESS.sandbox,
  timeEntry: ACCOUNT_ACCESS.sandbox,
  expense: ACCOUNT_ACCESS.sandbox,
  view: ACCOUNT_ACCESS.sandbox,
  property: ACCOUNT_ACCESS.sandbox,
  playbook: ACCOUNT_ACCESS.sandbox,
  flow: ACCOUNT_ACCESS.sandbox,
  signal: ACCOUNT_ACCESS.sandbox,
  billingCode: ACCOUNT_ACCESS.sandbox,
  rate: ACCOUNT_ACCESS.sandbox,
  chat: ACCOUNT_ACCESS.sandbox,
  auditLog: ACCOUNT_ACCESS.sandbox,
  agentSkill: ACCOUNT_ACCESS.sandbox,
  firmMemory: ACCOUNT_ACCESS.sandbox,
  caseLawResearch: ACCOUNT_ACCESS.sandbox,
  legalReaderAnnotation: ACCOUNT_ACCESS.sandbox,
  savedSearch: ACCOUNT_ACCESS.sandbox,
} as const satisfies Record<keyof typeof statements, AccountAccess>;

const requiresStandardResourceWrite = (permissions: Record<string, string[]>) =>
  Object.entries(RESOURCE_WRITE_ACCOUNT_ACCESS).some(
    ([resource, access]) =>
      access === ACCOUNT_ACCESS.standard &&
      (permissions[resource] ?? []).some((action) => action !== "read"),
  );

// Every endpoint refused to the demo account; a change here is a policy change.
const REVIEWED_STANDARD_OPERATIONS = [
  "apps/api/src/handlers/agent-auth/confirm.ts",
  "apps/api/src/handlers/ai-config/validate-provider.ts",
  "apps/api/src/handlers/api-keys/create.ts",
  "apps/api/src/handlers/api-keys/list.ts",
  "apps/api/src/handlers/api-keys/personal/create.ts",
  "apps/api/src/handlers/api-keys/personal/list.ts",
  "apps/api/src/handlers/api-keys/personal/policy.ts",
  "apps/api/src/handlers/api-keys/personal/revoke-organization.ts",
  "apps/api/src/handlers/api-keys/personal/revoke.ts",
  "apps/api/src/handlers/api-keys/personal/rotate.ts",
  "apps/api/src/handlers/api-keys/revoke.ts",
  "apps/api/src/handlers/api-keys/rotate.ts",
  "apps/api/src/handlers/audit-logs/export.ts",
  "apps/api/src/handlers/chat/export/create.ts",
  "apps/api/src/handlers/clauses/export.ts",
  "apps/api/src/handlers/contacts/export.ts",
  "apps/api/src/handlers/document-reviews/export-run.ts",
  "apps/api/src/handlers/document-types/create.ts",
  "apps/api/src/handlers/document-types/delete.ts",
  "apps/api/src/handlers/document-types/reorder.ts",
  "apps/api/src/handlers/document-types/update.ts",
  "apps/api/src/handlers/entities/zip/download.ts",
  "apps/api/src/handlers/feedback/create.ts",
  "apps/api/src/handlers/files/routes.ts#ocrExportEndpoint",
  "apps/api/src/handlers/files/routes.ts#printPdfEndpoint",
  "apps/api/src/handlers/files/routes.ts#scrubbedDownloadEndpoint",
  "apps/api/src/handlers/files/routes.ts#stampedDownloadEndpoint",
  "apps/api/src/handlers/mcp-connectors/approve-authorization.ts",
  "apps/api/src/handlers/mcp-connectors/connect.ts",
  "apps/api/src/handlers/mcp-connectors/create-connection.ts",
  "apps/api/src/handlers/mcp-connectors/create-connector.ts",
  "apps/api/src/handlers/mcp-connectors/delete-connection.ts",
  "apps/api/src/handlers/mcp-connectors/delete-connector.ts",
  "apps/api/src/handlers/mcp-connectors/oauth-callback.ts",
  "apps/api/src/handlers/mcp-connectors/probe-connector.ts",
  "apps/api/src/handlers/mcp-connectors/update-connection.ts",
  "apps/api/src/handlers/mcp-connectors/update-native-tool.ts",
  "apps/api/src/handlers/me/disconnect-oauth-connection.ts",
  "apps/api/src/handlers/me/verify-delete.ts",
  "apps/api/src/handlers/number-series/archive.ts",
  "apps/api/src/handlers/number-series/create.ts",
  "apps/api/src/handlers/number-series/default/update.ts",
  "apps/api/src/handlers/number-series/get.ts",
  "apps/api/src/handlers/number-series/list.ts",
  "apps/api/src/handlers/number-series/preview.ts",
  "apps/api/src/handlers/number-series/update.ts",
  "apps/api/src/handlers/organization-settings/anonymization-blacklist/get.ts",
  "apps/api/src/handlers/organization-settings/anonymization-blacklist/update.ts",
  "apps/api/src/handlers/organization-settings/business-registry-credentials.ts#deleteBusinessRegistryCredential",
  "apps/api/src/handlers/organization-settings/business-registry-credentials.ts#saveBusinessRegistryCredential",
  "apps/api/src/handlers/organization-settings/correspondence/allowed-senders/create.ts",
  "apps/api/src/handlers/organization-settings/correspondence/allowed-senders/delete.ts",
  "apps/api/src/handlers/organization-settings/correspondence/allowed-senders/list.ts",
  "apps/api/src/handlers/organization-settings/correspondence/allowed-senders/scope/add.ts",
  "apps/api/src/handlers/organization-settings/correspondence/allowed-senders/scope/remove.ts",
  "apps/api/src/handlers/organization-settings/delete-ai-config.ts",
  "apps/api/src/handlers/organization-settings/delete-deepl-key.ts",
  "apps/api/src/handlers/organization-settings/delete-web-search-key.ts",
  "apps/api/src/handlers/organization-settings/practice-jurisdictions/update.ts",
  "apps/api/src/handlers/organization-settings/preview.ts",
  "apps/api/src/handlers/organization-settings/read-ai-config.ts",
  "apps/api/src/handlers/organization-settings/read-deepl-config.ts",
  "apps/api/src/handlers/organization-settings/read-web-search-config.ts",
  "apps/api/src/handlers/organization-settings/sanctions-monitoring/update.ts",
  "apps/api/src/handlers/organization-settings/update-ai-config.ts",
  "apps/api/src/handlers/organization-settings/update-deepl-key.ts",
  "apps/api/src/handlers/organization-settings/update-web-search-key.ts",
  "apps/api/src/handlers/organization-settings/update.ts",
  "apps/api/src/handlers/reports/exports/get.ts",
  "apps/api/src/handlers/reports/views/export.ts",
  "apps/api/src/handlers/seller-profiles/archive.ts",
  "apps/api/src/handlers/seller-profiles/create.ts",
  "apps/api/src/handlers/seller-profiles/default/update.ts",
  "apps/api/src/handlers/seller-profiles/get.ts",
  "apps/api/src/handlers/seller-profiles/list.ts",
  "apps/api/src/handlers/seller-profiles/update.ts",
  "apps/api/src/handlers/sharepoint/connect.ts",
  "apps/api/src/handlers/sharepoint/disconnect.ts",
  "apps/api/src/handlers/sharepoint/oauth-callback.ts",
  "apps/api/src/handlers/sharepoint/set-enablement.ts",
  "apps/api/src/handlers/style-sets/download.ts",
  "apps/api/src/handlers/template-packs/visibility/update.ts",
  "apps/api/src/handlers/templates/fill.ts",
  "apps/api/src/handlers/templates/fills/download.ts",
  "apps/api/src/handlers/time-entries/csv/export.ts",
  "apps/api/src/handlers/time-entries/ledes/export.ts",
  "apps/api/src/handlers/time-entries/members/daily-target/update.ts",
  "apps/api/src/handlers/time-entries/pdf/export.ts",
  "apps/api/src/handlers/usage/assign-seat.ts",
  "apps/api/src/handlers/usage/create-hosted-management.ts",
  "apps/api/src/handlers/usage/create-hosted-setup.ts",
  "apps/api/src/handlers/usage/entitlement/get.ts",
  "apps/api/src/handlers/usage/list-policies.ts",
  "apps/api/src/handlers/usage/list-seat-assignments.ts",
  "apps/api/src/handlers/usage/unassign-seat.ts",
  "apps/api/src/handlers/vat-rates/archive.ts",
  "apps/api/src/handlers/vat-rates/create.ts",
  "apps/api/src/handlers/vat-rates/list.ts",
  "apps/api/src/handlers/vat-rates/update.ts",
  "apps/api/src/handlers/views/table/export.ts",
  "apps/api/src/handlers/workspaces/correspondence/address/create.ts",
  "apps/api/src/handlers/workspaces/correspondence/address/delete.ts",
  "apps/api/src/handlers/workspaces/duplicate.ts",
  "apps/api/src/handlers/workspaces/export-overview-activity.ts",
  "apps/api/src/handlers/workspaces/members/add.ts",
  "apps/api/src/handlers/workspaces/members/remove.ts",
] as const;

describe("handler account policy census", () => {
  test("every endpoint declares its account access", async () => {
    const discovery = await discoverSafeHandlers();
    expect(discovery.importErrors).toEqual([]);
    expect(discovery.endpoints.length).toBeGreaterThan(0);
    const undeclared: string[] = [];
    const sandboxResourceWrites: string[] = [];
    const standardOperations: string[] = [];
    for (const endpoint of discovery.endpoints) {
      const parsed = v.safeParse(configSchema, endpoint.config);
      if (!parsed.success) {
        undeclared.push(endpoint.id);
        continue;
      }
      const { accountAccess, permissions = {} } = parsed.output;
      if (accountAccess === ACCOUNT_ACCESS.standard) {
        standardOperations.push(endpoint.id);
        continue;
      }
      if (requiresStandardResourceWrite(permissions)) {
        sandboxResourceWrites.push(endpoint.id);
      }
    }
    expect(undeclared).toEqual([]);
    expect(sandboxResourceWrites).toEqual([]);
    expect(standardOperations.toSorted()).toEqual([
      ...REVIEWED_STANDARD_OPERATIONS,
    ]);
  });

  test("standard operations apply account access before their implementation", async () => {
    const previousEmail = env.DEMO_ACCOUNT_EMAIL;
    env.DEMO_ACCOUNT_EMAIL = "account@example.test";
    const definitionSchema = v.object({ handler: v.function() });
    try {
      for (const endpoint of (await discoverSafeHandlers()).endpoints) {
        if (!REVIEWED_STANDARD_OPERATIONS.some((id) => id === endpoint.id)) {
          continue;
        }
        const module = v.parse(
          v.record(v.string(), v.unknown()),
          await import(
            new URL(`../../../../../${endpoint.file}`, import.meta.url).href
          ),
        );
        const { handler } = v.parse(
          definitionSchema,
          module[endpoint.exportName ?? "default"],
        );
        const response = await handler(
          createTestHandlerContext({ user: { email: "account@example.test" } }),
        );
        expect(response, endpoint.id).toMatchObject({
          code: 403,
          response: { code: "account_access_unavailable" },
        });
      }
    } finally {
      env.DEMO_ACCOUNT_EMAIL = previousEmail;
    }
  });
});
