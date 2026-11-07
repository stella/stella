import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  assertTenfoldSmokeWorlds,
  claimRouteSmokeScale,
  getSmokeWorlds,
  readSmokeWorlds,
  SMOKE_WORLD_COUNTS,
  SMOKE_WORLD_DIMENSIONS,
  type SmokeCardinalities,
  type SmokeScaleWorld,
  smokeWorldDirectory,
} from "../helpers/smoke-world";

const small = {
  entities: 200,
  documents: 100,
  contacts: 100,
  versions: 300,
  chatThreads: 100,
  listRows: 100,
} satisfies SmokeCardinalities;
const large = {
  entities: 2000,
  documents: 1000,
  contacts: 1000,
  versions: 3000,
  chatThreads: 1000,
  listRows: 1000,
} satisfies SmokeCardinalities;

describe("smoke world cardinality", () => {
  test("starts at a full hundred-row page and scales every fixture dimension tenfold", () => {
    expect(SMOKE_WORLD_COUNTS.small).toBeGreaterThanOrEqual(100);
    expect(SMOKE_WORLD_COUNTS.large + 0).toBe(SMOKE_WORLD_COUNTS.small * 10);
    assertTenfoldSmokeWorlds({ small, large });
  });

  test("refuses any dimension that was omitted from large-world generation", () => {
    for (const dimension of SMOKE_WORLD_DIMENSIONS) {
      const invalidLarge: SmokeCardinalities = { ...large };
      invalidLarge[dimension] = 100;
      expect(() =>
        assertTenfoldSmokeWorlds({
          small,
          large: invalidLarge,
        }),
      ).toThrow(`${dimension}: expected positive tenfold fixtures`);
    }
  });

  test("refuses empty dimensions even when their ratio would compare equal", () => {
    for (const dimension of Object.keys(small)) {
      expect(() =>
        assertTenfoldSmokeWorlds({
          small: { ...small, [dimension]: 0 },
          large: { ...large, [dimension]: 0 },
        }),
      ).toThrow(`${dimension}: expected positive tenfold fixtures`);
    }
  });
});

test("replacement workers reuse the completed worlds outside the artifact directory", async () => {
  const scope = { runId: randomUUID() };
  const outputDirectory = path.join(
    tmpdir(),
    `smoke-artifacts-${randomUUID()}`,
  );
  const directory = smokeWorldDirectory(outputDirectory, scope);
  try {
    expect(directory.startsWith(`${outputDirectory}${path.sep}`)).toBe(false);
    expect(await readSmokeWorlds(outputDirectory, scope)).toBeNull();
    const world = {
      workspace: {
        id: "workspace",
        viewId: "view",
        filePropertyId: "property",
      },
      contactId: "contact",
      documentRoute: { entityId: "document", path: "/document" },
      correspondenceId: "correspondence",
      storageState: { cookies: [], origins: [] },
      cardinalities: small,
    } satisfies SmokeScaleWorld;
    const worlds = { small: world, large: { ...world, cardinalities: large } };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(directory, "worlds.json");
    await writeFile(snapshotPath, JSON.stringify(worlds), { mode: 0o600 });
    expect(await readSmokeWorlds(outputDirectory, scope)).toEqual(worlds);
    expect(await getSmokeWorlds(outputDirectory, scope)).toEqual(worlds);
    await rm(snapshotPath);
    // The same worker keeps its promise; a replacement reads the same pair
    // from the on-disk snapshot, as exercised by the uncached reader above.
    expect(await getSmokeWorlds(outputDirectory, scope)).toEqual(worlds);
    await writeFile(snapshotPath, JSON.stringify({ ...worlds, large: world }), {
      mode: 0o600,
    });
    expect(
      await rejectionOf(readSmokeWorlds(outputDirectory, scope)),
    ).toMatchObject({
      message: expect.stringContaining("expected positive tenfold fixtures"),
    });
    await writeFile(snapshotPath, "{", { mode: 0o600 });
    expect(
      await rejectionOf(readSmokeWorlds(outputDirectory, scope)),
    ).toBeInstanceOf(SyntaxError);
    expect(await readFile(snapshotPath, "utf-8")).toBe("{");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed pregranted tenants reject a competing invocation and a stale claim", async () => {
  const directory = path.join(tmpdir(), `smoke-claim-${randomUUID()}`);
  const claimPath = path.join(directory, "route-smoke-scale.claim");
  const ownerRunId = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await claimRouteSmokeScale({ claimPath, runId: ownerRunId });
    await claimRouteSmokeScale({ claimPath, runId: ownerRunId });
    expect(
      await rejectionOf(
        claimRouteSmokeScale({ claimPath, runId: randomUUID() }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("claimed by another invocation"),
    });
    expect(await readFile(claimPath, "utf-8")).toBe(ownerRunId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
