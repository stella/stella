import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { roleOptions } from "@/lib/auth-queries";
import { cachedRoleGrants } from "@/lib/cached-permissions.logic";

const CREATE_CONTACT = { contact: ["create"] } as const;

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
