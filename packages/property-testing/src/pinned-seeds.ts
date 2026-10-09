import { Result } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PropertyTestConfigError } from "./property-test-config-error";

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const PROPERTY_SEEDS_FILE =
  "packages/property-testing/property-seeds.json";
export const REPLAY_PATH_PATTERN = /^\d+(:\d+)*$/u;

export type PinnedSeed = {
  seed: number;
  path?: string;
  note: string;
  date: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parsePinnedSeeds = (
  value: unknown,
): Result<Record<string, PinnedSeed[]>, PropertyTestConfigError> => {
  if (!isRecord(value)) {
    return Result.err(
      new PropertyTestConfigError("Property seeds must be an object"),
    );
  }
  const entries: Record<string, PinnedSeed[]> = {};
  const keys = Object.keys(value).filter((key) => !key.startsWith("$"));
  if (
    keys.some((key, index) => {
      const previous = keys.at(index - 1);
      return index > 0 && previous !== undefined && previous >= key;
    })
  ) {
    return Result.err(
      new PropertyTestConfigError(
        "Property seed keys must be sorted and duplicate-free",
      ),
    );
  }
  for (const [key, seeds] of Object.entries(value)) {
    if (key.startsWith("$")) {
      continue;
    }
    if (!Array.isArray(seeds)) {
      return Result.err(
        new PropertyTestConfigError(
          `${key}: expected an array of pinned seeds`,
        ),
      );
    }
    const seedEntries: readonly unknown[] = seeds;
    const parsedSeeds: PinnedSeed[] = [];
    for (const entry of seedEntries) {
      if (
        !isRecord(entry) ||
        typeof entry["seed"] !== "number" ||
        !Number.isSafeInteger(entry["seed"]) ||
        typeof entry["note"] !== "string" ||
        entry["note"].trim() === "" ||
        typeof entry["date"] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(entry["date"]) ||
        (entry["path"] !== undefined &&
          (typeof entry["path"] !== "string" ||
            !REPLAY_PATH_PATTERN.test(entry["path"])))
      ) {
        return Result.err(
          new PropertyTestConfigError(
            `${key}: invalid seed, path, note or date`,
          ),
        );
      }
      const base = {
        seed: entry["seed"],
        note: entry["note"],
        date: entry["date"],
      };
      if (typeof entry["path"] === "string") {
        parsedSeeds.push({ ...base, path: entry["path"] });
      } else {
        parsedSeeds.push(base);
      }
    }
    entries[key] = parsedSeeds;
  }
  return Result.ok(entries);
};

let cachedSeeds: Record<string, PinnedSeed[]> | undefined;

export const readPinnedSeeds = (): Result<
  Record<string, PinnedSeed[]>,
  PropertyTestConfigError
> => {
  if (cachedSeeds !== undefined) {
    return Result.ok(cachedSeeds);
  }
  return Result.try({
    try: (): unknown =>
      JSON.parse(
        readFileSync(path.join(REPO_ROOT, PROPERTY_SEEDS_FILE), "utf-8"),
      ),
    catch: (cause) =>
      new PropertyTestConfigError("Unable to read property seeds", cause),
  })
    .andThen(parsePinnedSeeds)
    .tap((seeds) => {
      cachedSeeds = seeds;
    });
};
