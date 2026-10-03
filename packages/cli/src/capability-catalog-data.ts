// Raw committed contract data: preserve every field for API consumers.
import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";

/** Read shards in capability-id order; no CLI schema projection is applied. */
export const readCapabilityCatalog = (
  directory: URL = new URL("../capabilities/", import.meta.url),
): unknown[] => {
  const entries: unknown[] = [];
  for (const filename of readdirSync(directory).toSorted()) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+\.json$/u.test(
        filename,
      )
    ) {
      panic(`Unexpected capability catalog shard: ${filename}`);
    }
    const entry: unknown = JSON.parse(
      readFileSync(new URL(filename, directory), "utf-8"),
    );
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      `${entry.id}.json` !== filename
    ) {
      panic(`Capability catalog shard ${filename} has an invalid id`);
    }
    entries.push(entry);
  }
  return entries;
};

/** Curated-tool references must resolve in the same committed registry. */
export const checkCapabilityRegistry = (
  entries: readonly unknown[],
  toolNames: ReadonlySet<string>,
): void => {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("mcp" in entry)) {
      panic("Capability catalog entry has no MCP disposition");
    }
    const disposition = entry.mcp;
    if (
      typeof disposition !== "object" ||
      disposition === null ||
      !("type" in disposition)
    ) {
      panic("Capability catalog entry has an invalid MCP disposition");
    }
    let tool: unknown;
    switch (disposition.type) {
      case "tool":
        tool = "name" in disposition ? disposition.name : undefined;
        break;
      case "covered":
        tool = "by" in disposition ? disposition.by : undefined;
        break;
      case "capability":
        continue;
      default:
        panic("Unexpected capability MCP disposition");
    }
    if (typeof tool !== "string" || !toolNames.has(tool)) {
      panic(
        `Capability catalog references missing registry tool: ${String(tool)}`,
      );
    }
  }
};
