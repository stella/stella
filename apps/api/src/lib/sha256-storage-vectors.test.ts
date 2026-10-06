import { expect, test } from "bun:test";

import { auditedSkillBody } from "./agent-skills/audited-body";
import { hashSkillPackageContent } from "./agent-skills/content-hash";
import { hashSessionToken } from "./auth/session-token";
import { toSafeId } from "./branded-types";
import { hashOpaqueToken } from "./entities/opaque-tokens";
import { comparisonVersionId } from "./entity-versions/comparison-version-id";
import { shortToolNameHash } from "./mcp-upstream/namespace";
import { createMemoryDedupIdentity } from "./memory/memory-dedup";
import { brandDerivedCorrespondenceDropId } from "./safe-id-boundaries";

const text = "Článek\u0000📄\ud800";

// Literal digests pin the persisted formats independently of the hash owner.
test("persisted skill and memory identities retain their byte vectors", () => {
  expect(
    hashSkillPackageContent({
      name: "test",
      description: "\u010cl\u00e1nek",
      body: "\u010cl\u00e1nek\u0000\ud83d\udcc4\ud800",
      version: "1",
      license: null,
      compatibility: "node",
      metadata: { z: "last", a: "first" },
      resources: [
        { path: "z.txt", content: "\u010cl\u00e1nek\u0000\ud83d\udcc4\ud800" },
        { path: "a.txt", content: "binary-ish\u0000" },
      ],
    }),
  ).toBe("3dd902e38a5fdbf9e9d6e3100959aea12cb05dd985673cd93a072e1dd030799c");
  expect(
    createMemoryDedupIdentity({
      scope: "workspace",
      userId: null,
      workspaceId: toSafeId<"workspace">(
        "00000000-0000-4000-8000-000000000001",
      ),
      kind: "fact",
      content: text,
      sourceDataWorkspaceIds: [
        toSafeId<"workspace">("00000000-0000-4000-8000-000000000010"),
        toSafeId<"workspace">("00000000-0000-4000-8000-000000000009"),
        toSafeId<"workspace">("00000000-0000-4000-8000-000000000010"),
      ],
    }),
  ).toEqual({
    dedupKey:
      "434fd9e1b54c784235df4cca2e1e7f7d1dc385685ee91bb87a9721893121ccf7",
    sourceDataWorkspaceIds: [
      toSafeId<"workspace">("00000000-0000-4000-8000-000000000009"),
      toSafeId<"workspace">("00000000-0000-4000-8000-000000000010"),
    ],
  });
});

test("audit and token digests retain UTF-8 byte vectors", () => {
  expect(auditedSkillBody(text)).toEqual({
    sizeBytes: 16,
    sha256: "538101558ae518cf05d6b09c3d882716760824eed529051e60838a3bad85896c",
  });
  expect(hashSessionToken(text)).toEqual(
    "538101558ae518cf05d6b09c3d882716760824eed529051e60838a3bad85896c",
  );
  expect(hashOpaqueToken(text)).toEqual(
    "538101558ae518cf05d6b09c3d882716760824eed529051e60838a3bad85896c",
  );
  expect(shortToolNameHash(text)).toEqual("53810155");
});

test("derived artifact identities retain their UUID byte layout", () => {
  expect(
    brandDerivedCorrespondenceDropId(
      toSafeId<"workspace">("00000000-0000-4000-8000-000000000001"),
      text,
    ),
  ).toBe(
    toSafeId<"correspondenceDropLog">("6dcc17e4-8f25-8095-8824-33630a9b1dc8"),
  );
  expect(
    comparisonVersionId({
      organizationId: toSafeId<"organization">(
        "00000000-0000-4000-8000-000000000002",
      ),
      workspaceId: toSafeId<"workspace">(
        "00000000-0000-4000-8000-000000000003",
      ),
      entityId: toSafeId<"entity">("00000000-0000-4000-8000-000000000004"),
      userId: toSafeId<"user">("00000000-0000-4000-8000-000000000005"),
      filePropertyId: toSafeId<"property">(
        "00000000-0000-4000-8000-000000000006",
      ),
      source: {
        kind: "comparison",
        baseVersionId: toSafeId<"entityVersion">(
          "00000000-0000-4000-8000-000000000007",
        ),
        targetVersionId: toSafeId<"entityVersion">(
          "00000000-0000-4000-8000-000000000008",
        ),
        mode: "strict",
        granularity: "word",
        baseTrackedChanges: "keep",
        targetTrackedChanges: "accept",
      },
    }),
  ).toBe(toSafeId<"entityVersion">("23c4c1ae-be38-8e2f-89ca-ec0e32983c76"));
});
