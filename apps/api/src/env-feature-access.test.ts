import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  createFeatureAccessGrantsOwner,
  envFeatureAccess,
  readFeatureAccessGrants,
} from "@/api/env-feature-access";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
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
