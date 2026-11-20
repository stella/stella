import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { PermissionInput } from "@stll/permissions";

import { roleOptions } from "@/lib/auth-queries";
import {
  cachedCallerFeatureEnabled,
  cachedRoleGrants,
} from "@/lib/organization/cached-permissions.logic";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { organizationSettingsKeys } from "@/queries/organization-settings";
import type { OrganizationSettings } from "@/queries/organization-settings";

const CREATE_CONTACT: PermissionInput = { contact: ["create"] };

describe("a loading view's reading of the cached role", () => {
  test("grants what the cached role grants", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(roleOptions.queryKey, "owner");
    expect(cachedRoleGrants(queryClient, CREATE_CONTACT)).toBe(true);
  });

  test("withholds what the cached role does not grant", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(roleOptions.queryKey, "external");
    expect(cachedRoleGrants(queryClient, CREATE_CONTACT)).toBe(false);
  });

  test("grants nothing before the role is cached", () => {
    expect(cachedRoleGrants(new QueryClient(), CREATE_CONTACT)).toBe(false);
  });

  test("grants nothing when the role's last read failed", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(roleOptions.queryKey, "owner");
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: roleOptions.queryKey });
    query?.setState({ error: new Error("role read failed") });
    expect(query?.state.data).toBe("owner");
    expect(cachedRoleGrants(queryClient, CREATE_CONTACT)).toBe(false);
  });
});

// Organization settings as the read returns them for the caller; only the
// availability fields matter to a feature.
const settingsAdmitting = (
  featureIds: readonly string[],
): Pick<
  OrganizationSettings,
  "capabilities" | "declaredFeatureIds" | "deploymentFeatures"
> => ({
  declaredFeatureIds: [...featureIds],
  capabilities: Object.fromEntries(
    featureIds.map((id) => [id, { status: "enabled" as const }]),
  ),
  deploymentFeatures: { legalLists: false, invoiceLinks: false },
});

const CALLER = { organizationId: "org-a", userId: "user-a" };

describe("a loading view's reading of the cached organization features", () => {
  test("admits a feature the cached settings enable", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      organizationSettingsKeys.byCaller(CALLER),
      settingsAdmitting([CALLER_FEATURE.aiMemory.id]),
    );
    expect(cachedCallerFeatureEnabled(queryClient, "aiMemory")).toBe(true);
    expect(cachedCallerFeatureEnabled(queryClient, "verification")).toBe(false);
  });

  test("admits a feature only with the features it requires", () => {
    const queryClient = new QueryClient();
    const key = organizationSettingsKeys.byCaller(CALLER);
    queryClient.setQueryData(
      key,
      settingsAdmitting([CALLER_FEATURE.verification.id]),
    );
    expect(cachedCallerFeatureEnabled(queryClient, "verification")).toBe(false);
    queryClient.setQueryData(
      key,
      settingsAdmitting([
        CALLER_FEATURE.verification.id,
        CALLER_FEATURE.legalLists.id,
      ]),
    );
    expect(cachedCallerFeatureEnabled(queryClient, "verification")).toBe(true);
  });

  test("admits nothing before the settings are cached", () => {
    expect(cachedCallerFeatureEnabled(new QueryClient(), "aiMemory")).toBe(
      false,
    );
  });

  test("admits nothing when the settings' last read failed", () => {
    const queryClient = new QueryClient();
    const key = organizationSettingsKeys.byCaller(CALLER);
    queryClient.setQueryData(
      key,
      settingsAdmitting([CALLER_FEATURE.aiMemory.id]),
    );
    const query = queryClient.getQueryCache().find({ queryKey: key });
    query?.setState({ error: new Error("settings read failed") });
    expect(query?.state.data === undefined).toBe(false);
    expect(cachedCallerFeatureEnabled(queryClient, "aiMemory")).toBe(false);
  });
});
