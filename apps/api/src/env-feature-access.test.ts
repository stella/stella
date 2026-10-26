import { describe, expect, spyOn, test } from "bun:test";

import { ParameterStoreError } from "@stll/parameter-store";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  createFeatureAccessGrantsOwner,
  envFeatureAccess,
  readFeatureAccessGrants,
  startFeatureAccessGrantsRefresh,
} from "@/api/env-feature-access";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { logger } from "@/api/lib/observability/logger";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const ORGANIZATION_ID = "org_12345678901234567890123456789012";
const initialGrants = {} satisfies FeatureAccessGrants;
const updatedGrants = {
  "legal-lists": [{ type: "organization", organizationId: ORGANIZATION_ID }],
} as const satisfies FeatureAccessGrants;

class FakeSsmClient {
  version = 1;
  raw = JSON.stringify(initialGrants);
  versionChecks = 0;
  valueReads = 0;
  error: Error | null = null;

  readonly source = {
    readVersion: async (): Promise<number> => {
      this.versionChecks += 1;
      if (this.error !== null) {
        throw this.error;
      }
      return this.version;
    },
    readValue: async (): Promise<{ raw: string; version: number }> => {
      this.valueReads += 1;
      if (this.error !== null) {
        throw this.error;
      }
      return { raw: this.raw, version: this.version };
    },
  };
}

const createOwner = (client: FakeSsmClient, failures: unknown[]) =>
  createFeatureAccessGrantsOwner({
    initial: { grants: initialGrants, version: 1 },
    onRefreshFailure: (error) => {
      failures.push(error);
    },
    source: client.source,
  });

test("the server awaits initial grants before exposing requests", async () => {
  const server = await Bun.file(new URL("server.ts", import.meta.url)).text();
  expect(server).toMatch(
    /await startFeatureAccessGrantsRefresh\(\);[\s\S]*?\n {2}const server = Bun\.serve\(/u,
  );
});

test("test fixtures can replace the snapshot while exercising strict access", () => {
  const initial = readFeatureAccessGrants();
  const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  try {
    envFeatureAccess.API_FEATURE_ACCESS_GRANTS = updatedGrants;
    expect(readFeatureAccessGrants()).toEqual({
      grants: updatedGrants,
      version: null,
    });
    expect(envFeatureAccess.API_FEATURE_ACCESS_GRANTS).toBe(updatedGrants);
  } finally {
    restore();
    envFeatureAccess.API_FEATURE_ACCESS_GRANTS = initial.grants;
  }
});

describe("feature access grant refresh", () => {
  test.each([
    { name: "revoked", grants: initialGrants },
    { name: "unchanged", grants: updatedGrants },
  ])(
    "startup publishes $name SSM grants before returning",
    async ({ grants }) => {
      const previous = readFeatureAccessGrants();
      envFeatureAccess.API_FEATURE_ACCESS_GRANTS = updatedGrants;
      const client = new FakeSsmClient();
      client.raw = JSON.stringify(grants);
      const stop = await startFeatureAccessGrantsRefresh({
        parameterName: "test-grants",
        source: client.source,
      });
      try {
        expect(readFeatureAccessGrants()).toEqual({ grants, version: 1 });
        expect(client.valueReads).toBe(1);
      } finally {
        await stop?.();
        envFeatureAccess.API_FEATURE_ACCESS_GRANTS = previous.grants;
      }
    },
  );

  test("unreachable SSM retains environment grants and reports startup failure", async () => {
    const previous = readFeatureAccessGrants();
    envFeatureAccess.API_FEATURE_ACCESS_GRANTS = updatedGrants;
    const client = new FakeSsmClient();
    client.error = new Error("SSM unavailable");
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const stop = await startFeatureAccessGrantsRefresh({
      parameterName: "test-grants",
      source: client.source,
    });
    try {
      expect(readFeatureAccessGrants()).toEqual({
        grants: updatedGrants,
        version: null,
      });
      expect(errors.mock.calls).toEqual([
        [
          "feature_access.refresh_failed",
          expect.objectContaining({
            "error.type": "Error",
            "failure.policy": "grade",
          }),
        ],
      ]);
    } finally {
      await stop?.();
      errors.mockRestore();
      envFeatureAccess.API_FEATURE_ACCESS_GRANTS = previous.grants;
    }
  });

  test("a parameter-store refusal reports only its typed reason", async () => {
    const previous = readFeatureAccessGrants();
    const refusal = new ParameterStoreError({
      message: "private provider response",
      reason: "access_denied",
    });
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const stop = await startFeatureAccessGrantsRefresh({
      parameterName: "test-grants",
      source: {
        readVersion: async () => {
          throw refusal;
        },
        readValue: async () => {
          throw new Error("unexpected value read");
        },
      },
    });
    try {
      expect(readFeatureAccessGrants()).toEqual(previous);
      expect(errors.mock.calls).toEqual([
        [
          "feature_access.refresh_failed",
          expect.objectContaining({
            "error.type": "ParameterStoreError",
            "failure.grade": "defect",
            "failure.policy": "grade",
            "failure.reason": "tagged_failure",
            parameterStoreReason: "access_denied",
          }),
        ],
      ]);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(
        "private provider response",
      );
    } finally {
      await stop?.();
      errors.mockRestore();
    }
  });

  // timeout: the real five-second owner deadline needs room for scheduler jitter in CI.
  test("a stalled initial read releases startup within five seconds and cannot publish late grants", async () => {
    const previous = readFeatureAccessGrants();
    envFeatureAccess.API_FEATURE_ACCESS_GRANTS = updatedGrants;
    const late = Promise.withResolvers<{ raw: string; version: number }>();
    const lateReadSettled = Promise.withResolvers<undefined>();
    let requestSignal: AbortSignal | undefined;
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const started = performance.now();
    const stop = await startFeatureAccessGrantsRefresh({
      parameterName: "test-grants",
      source: {
        readVersion: async () => 1,
        readValue: async (signal) => {
          requestSignal = signal;
          try {
            return await late.promise;
          } finally {
            lateReadSettled.resolve(undefined);
          }
        },
      },
    });
    try {
      expect(performance.now() - started).toBeLessThan(6500);
      expect(requestSignal?.aborted).toBe(true);
      expect(readFeatureAccessGrants()).toEqual({
        grants: updatedGrants,
        version: null,
      });
      expect(errors.mock.calls).toEqual([
        [
          "feature_access.refresh_failed",
          expect.objectContaining({
            "error.type": "TimeoutError",
            "failure.policy": "grade",
          }),
        ],
      ]);
      expect(stop).toBeFunction();
      late.resolve({ raw: JSON.stringify(initialGrants), version: 1 });
      await lateReadSettled.promise;
      expect(readFeatureAccessGrants()).toEqual({
        grants: updatedGrants,
        version: null,
      });
    } finally {
      await stop?.();
      errors.mockRestore();
      envFeatureAccess.API_FEATURE_ACCESS_GRANTS = previous.grants;
    }
  }, 10_000);

  test("unknown refreshed grants report only their count once per version", async () => {
    const client = new FakeSsmClient();
    const owner = createOwner(client, []);
    client.version = 2;
    client.raw = JSON.stringify({
      ...updatedGrants,
      "unknown-feature": updatedGrants["legal-lists"],
    });
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await owner.refresh();
      await owner.refresh();
      expect(owner.read()).toEqual({ grants: updatedGrants, version: 2 });
      expect(errors.mock.calls).toEqual([
        [
          "feature_access.unknown_grant",
          {
            "feature_access.unknown_grant_count": 1,
          },
        ],
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  test("unchanged versions perform only the metadata check", async () => {
    const client = new FakeSsmClient();
    const owner = createOwner(client, []);

    await owner.refresh();

    expect(client.versionChecks).toBe(1);
    expect(client.valueReads).toBe(0);
    expect(owner.read()).toEqual({ grants: initialGrants, version: 1 });
  });

  test("a changed version atomically replaces grants on the next tick", async () => {
    const client = new FakeSsmClient();
    const owner = createOwner(client, []);
    client.version = 2;
    client.raw = JSON.stringify(updatedGrants);

    await owner.refresh();

    expect(client.versionChecks).toBe(1);
    expect(client.valueReads).toBe(1);
    expect(owner.read()).toEqual({ grants: updatedGrants, version: 2 });
  });

  test("older metadata and values cannot restore revoked grants", async () => {
    const client = new FakeSsmClient();
    const owner = createOwner(client, []);
    client.version = 11;
    client.raw = JSON.stringify(updatedGrants);
    await owner.refresh();

    client.version = 10;
    client.raw = JSON.stringify(initialGrants);
    await owner.refresh();
    expect(client.valueReads).toBe(1);
    expect(owner.read()).toEqual({ grants: updatedGrants, version: 11 });

    const ownerWithStaleValue = createFeatureAccessGrantsOwner({
      initial: owner.read(),
      onRefreshFailure: () => {},
      source: {
        readVersion: async () => 12,
        readValue: async () => ({
          raw: JSON.stringify(initialGrants),
          version: 10,
        }),
      },
    });
    await ownerWithStaleValue.refresh();
    expect(ownerWithStaleValue.read()).toEqual({
      grants: updatedGrants,
      version: 11,
    });
  });

  test("a late older response cannot replace a newer committed response", async () => {
    const oldResponse = Promise.withResolvers<{
      raw: string;
      version: number;
    }>();
    const oldReadStarted = Promise.withResolvers<undefined>();
    let versionReads = 0;
    let valueReads = 0;
    const owner = createFeatureAccessGrantsOwner({
      initial: { grants: initialGrants, version: 1 },
      onRefreshFailure: () => {},
      source: {
        readVersion: async () => {
          versionReads += 1;
          return versionReads === 1 ? 10 : 11;
        },
        readValue: async () => {
          valueReads += 1;
          if (valueReads === 1) {
            oldReadStarted.resolve(undefined);
            return oldResponse.promise;
          }
          return { raw: JSON.stringify(updatedGrants), version: 11 };
        },
      },
    });

    const oldRefresh = owner.refresh();
    await oldReadStarted.promise;
    await owner.refresh();
    expect(owner.read()).toEqual({ grants: updatedGrants, version: 11 });
    oldResponse.resolve({ raw: JSON.stringify(initialGrants), version: 10 });
    await oldRefresh;
    expect(owner.read()).toEqual({ grants: updatedGrants, version: 11 });
  });

  test("an SSM incident keeps the last good grants and logs once", async () => {
    const client = new FakeSsmClient();
    const failures: unknown[] = [];
    const owner = createOwner(client, failures);
    client.error = new Error("SSM unavailable");

    await owner.refresh();
    await owner.refresh();

    expect(owner.read()).toEqual({ grants: initialGrants, version: 1 });
    expect(failures).toEqual([client.error]);
  });

  test("the handler read path makes zero SSM calls", () => {
    const client = new FakeSsmClient();
    const owner = createOwner(client, []);

    const grantsUsedByHandler = owner.read().grants;

    expect(grantsUsedByHandler).toBe(initialGrants);
    expect(client.versionChecks).toBe(0);
    expect(client.valueReads).toBe(0);
  });
});
