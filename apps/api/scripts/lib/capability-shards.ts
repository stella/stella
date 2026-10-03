import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** JSON projection with sorted object keys; arrays retain their exact order. */
export const serializeCapabilityJson = (value: unknown) =>
  JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return child;
    }
    return Object.fromEntries(
      Object.entries(child).toSorted(([a], [b]) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      }),
    );
  });

/** The complete canonical contract document, terminated by one newline. */
export const serializeCapabilityShard = (entry: {
  readonly id: string;
}): string => `${serializeCapabilityJson(entry)}\n`;

type CapabilityShardOptions = {
  directory: string;
  shards: ReadonlyMap<string, string>;
  mode: "write" | "check";
};

/** Compare the complete directory, including files left by removed capabilities. */
export const syncCapabilityShards = async ({
  directory,
  shards,
  mode,
}: CapabilityShardOptions): Promise<string[]> => {
  if (mode === "write") {
    await mkdir(directory, { recursive: true });
  }
  const files = existsSync(directory) ? await readdir(directory) : [];
  const drift: string[] = [];
  for (const file of files) {
    if (shards.has(file)) {
      continue;
    }
    drift.push(file);
    if (mode === "write") {
      await unlink(path.join(directory, file));
    }
  }
  for (const [file, expected] of shards) {
    const actual = files.includes(file)
      ? await readFile(path.join(directory, file), "utf-8")
      : undefined;
    if (actual === expected) {
      continue;
    }
    drift.push(file);
    if (mode === "write") {
      await writeFile(path.join(directory, file), expected);
    }
  }
  return drift.toSorted();
};
