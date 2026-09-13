import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { comparisonVersionId } from "./comparison-version-id";

const identity = {
  organizationId: mintAuthProviderId<"organization">(),
  workspaceId: createSafeId<"workspace">(),
  entityId: createSafeId<"entity">(),
  userId: mintAuthProviderId<"user">(),
  filePropertyId: createSafeId<"property">(),
  source: {
    kind: "comparison" as const,
    baseVersionId: createSafeId<"entityVersion">(),
    targetVersionId: createSafeId<"entityVersion">(),
    mode: "strict" as const,
    granularity: "word" as const,
    baseTrackedChanges: "keep" as const,
    targetTrackedChanges: "accept" as const,
  },
};

const changedIdentities = [
  {
    field: "organization",
    identity: {
      ...identity,
      organizationId: mintAuthProviderId<"organization">(),
    },
  },
  {
    field: "workspace",
    identity: { ...identity, workspaceId: createSafeId<"workspace">() },
  },
  {
    field: "entity",
    identity: { ...identity, entityId: createSafeId<"entity">() },
  },
  {
    field: "user",
    identity: { ...identity, userId: mintAuthProviderId<"user">() },
  },
  {
    field: "file property",
    identity: { ...identity, filePropertyId: createSafeId<"property">() },
  },
  {
    field: "base version",
    identity: {
      ...identity,
      source: {
        ...identity.source,
        baseVersionId: createSafeId<"entityVersion">(),
      },
    },
  },
  {
    field: "target version",
    identity: {
      ...identity,
      source: {
        ...identity.source,
        targetVersionId: createSafeId<"entityVersion">(),
      },
    },
  },
  {
    field: "mode",
    identity: {
      ...identity,
      source: { ...identity.source, mode: "best-effort" as const },
    },
  },
  {
    field: "granularity",
    identity: {
      ...identity,
      source: { ...identity.source, granularity: "character" as const },
    },
  },
  {
    field: "base tracked changes",
    identity: {
      ...identity,
      source: { ...identity.source, baseTrackedChanges: "accept" as const },
    },
  },
  {
    field: "target tracked changes",
    identity: {
      ...identity,
      source: { ...identity.source, targetTrackedChanges: "reject" as const },
    },
  },
];

test("comparison version identity is deterministic across object key order", () => {
  const reorderedIdentity = {
    filePropertyId: identity.filePropertyId,
    userId: identity.userId,
    source: {
      targetTrackedChanges: identity.source.targetTrackedChanges,
      baseTrackedChanges: identity.source.baseTrackedChanges,
      granularity: identity.source.granularity,
      mode: identity.source.mode,
      targetVersionId: identity.source.targetVersionId,
      baseVersionId: identity.source.baseVersionId,
      kind: identity.source.kind,
    },
    entityId: identity.entityId,
    workspaceId: identity.workspaceId,
    organizationId: identity.organizationId,
  };

  expect(comparisonVersionId(reorderedIdentity)).toBe(
    comparisonVersionId(identity),
  );
});

test.each(changedIdentities)(
  "comparison version identity changes when $field changes",
  ({ identity: changedIdentity }) => {
    expect(comparisonVersionId(changedIdentity)).not.toBe(
      comparisonVersionId(identity),
    );
  },
);
