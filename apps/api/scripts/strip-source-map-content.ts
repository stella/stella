import { panic } from "better-result";

// Long-running bundles ship a linked source map so stack frames name source
// positions (error fingerprints depend on them). Mapping a frame needs only
// `sources`, `names` and `mappings`; the embedded source text is two thirds of
// the map and never read at runtime. Bun refuses a map without the field, so
// each entry becomes null, which the source map format allows.
export const stripSourceMapContent = async (mapPath: string) => {
  const map: unknown = await Bun.file(mapPath).json();
  const sources: unknown =
    typeof map === "object" && map !== null
      ? Reflect.get(map, "sources")
      : undefined;
  if (
    typeof map !== "object" ||
    map === null ||
    Reflect.get(map, "version") !== 3 ||
    !Array.isArray(sources) ||
    typeof Reflect.get(map, "mappings") !== "string"
  ) {
    panic(
      `${mapPath} is not a version 3 source map with sources and mappings; build the bundle with --sourcemap=linked`,
    );
  }
  await Bun.write(
    mapPath,
    JSON.stringify({ ...map, sourcesContent: sources.map(() => null) }),
  );
};

if (import.meta.main) {
  const mapPaths = process.argv.slice(2);
  if (mapPaths.length === 0) {
    panic("Usage: bun strip-source-map-content.ts <bundle.js.map>...");
  }
  for (const mapPath of mapPaths) {
    await stripSourceMapContent(mapPath);
  }
}
