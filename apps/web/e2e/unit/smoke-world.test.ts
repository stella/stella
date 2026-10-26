import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createTestState } from "../../../api/src/tests/helpers/test-state";
import {
  assertTenfoldSmokeWorlds,
  getSmokeWorlds,
  readSmokeWorlds,
  SMOKE_WORLD_COUNTS,
  SMOKE_WORLD_DIMENSIONS,
  type SmokeCardinalities,
  type SmokeScaleWorld,
  smokeWorldDirectory,
} from "../helpers/smoke-world";

const state = createTestState({ file: import.meta.path, config: {} });

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
  state.setEnv("E2E_ROUTE_SMOKE_RUN_ID", randomUUID());
  const outputDirectory = path.join(
    tmpdir(),
    `smoke-artifacts-${randomUUID()}`,
  );
  const directory = smokeWorldDirectory(outputDirectory);
  try {
    expect(directory.startsWith(`${outputDirectory}${path.sep}`)).toBe(false);
    expect(await readSmokeWorlds(outputDirectory)).toBeNull();
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
    expect(await readSmokeWorlds(outputDirectory)).toEqual(worlds);
    expect(await getSmokeWorlds(outputDirectory)).toEqual(worlds);
    await rm(snapshotPath);
    // The same worker keeps its promise; a replacement reads the same pair
    // from the on-disk snapshot, as exercised by the uncached reader above.
    expect(await getSmokeWorlds(outputDirectory)).toEqual(worlds);
    await writeFile(snapshotPath, JSON.stringify({ ...worlds, large: world }), {
      mode: 0o600,
    });
    expect(await rejectionOf(readSmokeWorlds(outputDirectory))).toMatchObject({
      message: expect.stringContaining("expected positive tenfold fixtures"),
    });
    await writeFile(snapshotPath, "{", { mode: 0o600 });
    expect(await rejectionOf(readSmokeWorlds(outputDirectory))).toBeInstanceOf(
      SyntaxError,
    );
    expect(await readFile(snapshotPath, "utf-8")).toBe("{");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
