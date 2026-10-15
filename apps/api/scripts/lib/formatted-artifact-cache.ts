import { panic } from "better-result";

type FormatBatch = (
  artifacts: ReadonlyMap<string, string>,
) => Promise<ReadonlyMap<string, string>>;

/**
 * Format generated artifacts, reusing earlier output for an artifact whose
 * file name, unformatted source and formatter configuration are all
 * identical. Only new or changed artifacts reach `formatBatch`, so repeated
 * exports in one process spawn the formatter only for what changed. Entries
 * not requested by the latest call are dropped, which bounds the cache to one
 * export's artifacts.
 */
export const createFormattedArtifactCache = (formatBatch: FormatBatch) => {
  let cachedConfiguration: string | undefined;
  let cache = new Map<string, { raw: string; formatted: string }>();
  return async (
    artifacts: ReadonlyMap<string, string>,
    configuration: string,
  ): Promise<Map<string, string>> => {
    if (configuration !== cachedConfiguration) {
      cache = new Map();
      cachedConfiguration = configuration;
    }
    const pending = new Map<string, string>();
    for (const [fileName, raw] of artifacts) {
      if (cache.get(fileName)?.raw !== raw) {
        pending.set(fileName, raw);
      }
    }
    const fresh: ReadonlyMap<string, string> =
      pending.size === 0 ? new Map() : await formatBatch(pending);
    const next = new Map<string, { raw: string; formatted: string }>();
    const formatted = new Map<string, string>();
    for (const [fileName, raw] of artifacts) {
      const output = pending.has(fileName)
        ? fresh.get(fileName)
        : cache.get(fileName)?.formatted;
      if (output === undefined) {
        return panic(`Formatter returned no output for ${fileName}`);
      }
      next.set(fileName, { raw, formatted: output });
      formatted.set(fileName, output);
    }
    cache = next;
    return formatted;
  };
};
