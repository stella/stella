import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { API_RUNTIME_ENTRIES } from "./api-runtime-entries";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf-8");

const packageEntries = (): string[] => {
  const manifest: unknown = JSON.parse(read("apps/api/package.json"));
  const scripts =
    typeof manifest === "object" &&
    manifest !== null &&
    "scripts" in manifest &&
    typeof manifest.scripts === "object" &&
    manifest.scripts !== null
      ? Object.values(manifest.scripts)
      : [];
  return scripts.flatMap((command) =>
    typeof command === "string"
      ? [
          // A preload configures a process; it does not start one.
          ...command
            .replaceAll(/--preload\s+\S+/gu, "")
            .matchAll(/(?:^|\s)(?:\.\/)?(src\/\S+\.ts)\b/gu),
        ].flatMap(([, file]) =>
          file === undefined ? [] : [`apps/api/${file}`],
        )
      : [],
  );
};

const imageEntries = (): string[] =>
  [...read("apps/api/Dockerfile").matchAll(/apps\/api\/src\/\S+\.ts/gu)].map(
    ([file]) => file,
  );

test("every API process the package scripts or the image start is a runtime entry", () => {
  const listed = API_RUNTIME_ENTRIES.map(({ file }) => file);
  const started = [...new Set([...packageEntries(), ...imageEntries()])];
  expect(started).toContain("apps/api/src/server.ts");
  expect(started.filter((file) => !listed.includes(file))).toEqual([]);
  // The list names no process that nothing starts and no missing file.
  expect(
    listed.filter(
      (file) => !started.includes(file) || !existsSync(path.join(ROOT, file)),
    ),
  ).toEqual([]);
  expect(listed.toSorted(compareCodeUnit)).toEqual(
    [...new Set(listed)].toSorted(compareCodeUnit),
  );
});
