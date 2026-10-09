import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  E2E_SHARD_COUNT,
  e2eShardForSpec,
  e2eSpecsForShard,
  listE2eSpecs,
  selectE2eSpecs,
  selectedE2eShards,
} from "./e2e-spec-shards";

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-spec-shards-"));
  const write = (file: string, contents = "") => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  write("apps/web/e2e/helpers/shared.ts", "export const shared = true;\n");
  write("apps/web/e2e/helpers/only-a.ts", "export const onlyA = true;\n");
  write("apps/web/e2e/helpers/index.ts", "export const helper = true;\n");
  write(
    "apps/web/e2e/specs/a.spec.ts",
    'import "../helpers";\nimport "../helpers/shared";\nimport "../helpers/only-a";\n',
  );
  write("apps/web/e2e/specs/b.spec.ts", 'import "../helpers/shared";\n');
  return { root, write };
};

describe("e2e spec shard selection", () => {
  test("assigns every spec to exactly one shared shard", () => {
    const specs = listE2eSpecs();
    const partitions = Array.from({ length: E2E_SHARD_COUNT }, (_, index) =>
      e2eSpecsForShard(index + 1, specs),
    );
    expect(partitions.flat().toSorted(compareCodeUnit)).toEqual(specs);
    for (const spec of specs) {
      expect(
        partitions.filter((partition) => partition.includes(spec)),
      ).toHaveLength(1);
      expect(e2eShardForSpec(spec, specs)).toBe(
        partitions.findIndex((partition) => partition.includes(spec)) + 1,
      );
    }
  });

  test("selects changed specs and every consumer of a changed helper", () => {
    const { root } = fixture();
    try {
      expect(selectE2eSpecs(["apps/web/e2e/specs/a.spec.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
      ]);
      expect(selectE2eSpecs(["apps/web/e2e/helpers/shared.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
        "apps/web/e2e/specs/b.spec.ts",
      ]);
      expect(
        selectedE2eShards(["apps/web/e2e/helpers/shared.ts"], root),
      ).toEqual([1, 2]);
      expect(selectE2eSpecs(["apps/web/e2e/helpers/index.ts"], root)).toEqual([
        "apps/web/e2e/specs/a.spec.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects nothing for unrelated changes or deleted specs", () => {
    const { root, write } = fixture();
    try {
      expect(selectE2eSpecs(["README.md"], root)).toEqual([]);
      write("apps/web/e2e/specs/deleted.spec.ts");
      rmSync(path.join(root, "apps/web/e2e/specs/deleted.spec.ts"));
      expect(
        selectE2eSpecs(["apps/web/e2e/specs/deleted.spec.ts"], root),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
