import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveAddToStellaState } from "@/features/knowledge/public/tools/add-to-stella.logic";

const entry = { kind: "skill" as const, slug: "contract-review-anthropic" };
const availableEntry = {
  ...entry,
  enabled: null,
  installState: "available" as const,
};

const retry = async () => panic("Unexpected catalogue retry");

describe("public catalogue install affordance", () => {
  test("requires authentication and waits for organization state", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "anonymous",
        canInstall: undefined,
        entry,
        catalogue: { type: "pending" },
      }),
    ).toEqual({ type: "sign-in" });
    expect(
      resolveAddToStellaState({
        authStatus: "unavailable",
        canInstall: undefined,
        entry,
        catalogue: { type: "pending" },
      }),
    ).toEqual({ type: "sign-in" });
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: undefined,
        entry,
        catalogue: { type: "pending" },
      }),
    ).toEqual({ type: "checking" });
  });

  test("fails closed when the active member cannot manage organization settings", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: false,
        entry,
        catalogue: {
          type: "items",
          retry,
          items: { entries: [availableEntry] },
        },
      }),
    ).toEqual({ type: "forbidden" });
  });

  test("preserves a retryable role lookup error instead of reporting forbidden", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: "error",
        entry,
        catalogue: {
          type: "items",
          retry,
          items: { entries: [availableEntry] },
        },
      }),
    ).toEqual({ type: "role-error" });
  });

  test("suppresses duplicate and unavailable installs", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry,
        catalogue: {
          type: "items",
          retry,
          items: {
            entries: [{ ...availableEntry, installState: "installed" }],
          },
        },
      }),
    ).toEqual({ type: "installed" });
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry,
        catalogue: {
          type: "items",
          retry,
          items: {
            entries: [{ ...availableEntry, installState: "unavailable" }],
          },
        },
      }),
    ).toEqual({ type: "unavailable" });
  });

  test("distinguishes a failed read from an unlisted tool", () => {
    const options = {
      authStatus: "authenticated",
      canInstall: true,
      entry,
    } as const;
    expect(
      resolveAddToStellaState({
        ...options,
        catalogue: {
          type: "error",
          error: new TypeError("read failed"),
          retry,
        },
      }),
    ).toEqual({ type: "catalogue-error" });
    expect(
      resolveAddToStellaState({
        ...options,
        catalogue: { type: "items", retry, items: { entries: [] } },
      }),
    ).toEqual({ type: "missing-entry" });
    expect(
      resolveAddToStellaState({
        ...options,
        catalogue: {
          type: "items",
          retry,
          items: { entries: [availableEntry] },
          refetchError: new TypeError("read failed"),
        },
      }),
    ).toEqual({ type: "catalogue-error" });
  });

  test("lets a disabled native tool be enabled again", () => {
    expect(
      resolveAddToStellaState({
        authStatus: "authenticated",
        canInstall: true,
        entry: { kind: "native-tool", slug: "web-search" },
        catalogue: {
          type: "items",
          retry,
          items: {
            entries: [
              {
                kind: "native-tool",
                slug: "web-search",
                enabled: false,
                installState: "installed",
              },
            ],
          },
        },
      }),
    ).toEqual({ type: "install" });
  });
});
