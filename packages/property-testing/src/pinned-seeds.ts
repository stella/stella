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
): Record<string, PinnedSeed[]> => {
  if (!isRecord(value)) {
    throw new PropertyTestConfigError("Property seeds must be an object");
  }
  const entries: Record<string, PinnedSeed[]> = {};
  for (const [key, seeds] of Object.entries(value)) {
    if (key.startsWith("$")) {
      continue;
    }
    if (!Array.isArray(seeds)) {
      throw new PropertyTestConfigError(
        `${key}: expected an array of pinned seeds`,
      );
    }
    entries[key] = seeds.map((entry: unknown) => {
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
        throw new PropertyTestConfigError(
          `${key}: invalid seed, path, note or date`,
        );
      }
      const base = {
        seed: entry["seed"],
        note: entry["note"],
        date: entry["date"],
      };
      if (typeof entry["path"] === "string") {
        return Object.assign(base, { path: entry["path"] });
      }
      return base;
    });
  }
  return entries;
};

let cachedSeeds: Record<string, PinnedSeed[]> | undefined;

export const readPinnedSeeds = (): Record<string, PinnedSeed[]> => {
  if (cachedSeeds !== undefined) {
    return cachedSeeds;
  }
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, PROPERTY_SEEDS_FILE), "utf-8"),
  );
  cachedSeeds = parsePinnedSeeds(parsed);
  return cachedSeeds;
};
