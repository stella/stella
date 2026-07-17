import { describe, expect, test } from "bun:test";

import { resolveAddToStellaState } from "@/routes/tools/-components/add-to-stella.logic";

const entry = { kind: "skill" as const, slug: "contract-review" };
const availableEntry = {
  ...entry,
  enabled: null,
  installState: "available" as const,
};

describe("public catalogue install affordance", () => {
  test("requires authentication and waits for organization state", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "anonymous",
        canInstall: undefined,
        entry,
        organizationEntries: undefined,
      }),
    ).toEqual({ type: "sign-in" });
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: undefined,
        entry,
        organizationEntries: undefined,
      }),
    ).toEqual({ type: "checking" });
  });

  test("fails closed when the active member cannot manage organization settings", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: false,
        entry,
        organizationEntries: [availableEntry],
      }),
    ).toEqual({ type: "forbidden" });
  });

  test("suppresses duplicate and unavailable installs", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry,
        organizationEntries: [{ ...availableEntry, installState: "installed" }],
      }),
    ).toEqual({ type: "installed" });
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry,
        organizationEntries: [
          { ...availableEntry, installState: "unavailable" },
        ],
      }),
    ).toEqual({ type: "unavailable" });
  });

  test("lets a disabled native tool be enabled again", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry: { kind: "native-tool", slug: "web-search" },
        organizationEntries: [
          {
            kind: "native-tool",
            slug: "web-search",
            enabled: false,
            installState: "installed",
          },
        ],
      }),
    ).toEqual({ type: "install" });
  });
});
