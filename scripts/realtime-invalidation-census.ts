import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const REALTIME_FILE = /(?:sse|realtime)/iu;
const DIRECT_INVALIDATION = /\.invalidateQueries\s*\(/u;
const SCHEDULER_MODULE = "apps/web/src/lib/workspaces/realtime-refresh.ts";

export type RealtimeSource = { path: string; source: string };

export const directRealtimeInvalidations = (sources: RealtimeSource[]) =>
  sources
    .filter(
      ({ path: filePath, source }) =>
        REALTIME_FILE.test(path.basename(filePath)) &&
        !filePath.endsWith(SCHEDULER_MODULE) &&
        DIRECT_INVALIDATION.test(source),
    )
    .map(({ path: filePath }) => filePath);

const readSources = async (directory: string): Promise<RealtimeSource[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: RealtimeSource[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await readSources(entryPath)));
    } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
      sources.push({
        path: entryPath,
        source: await readFile(entryPath, "utf-8"),
      });
    }
  }
  return sources;
};

if (import.meta.main) {
  const offenders = directRealtimeInvalidations(
    await readSources(path.join(import.meta.dir, "../apps/web/src/lib")),
  );
  if (offenders.length > 0) {
    console.error(
      `Realtime modules must use realtime-refresh.ts:\n${offenders.join("\n")}`,
    );
    process.exit(1);
  }
}
