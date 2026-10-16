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
 *
 * Calls may overlap. Each call resolves its reused outputs before awaiting the
 * formatter, so another call replacing the cache cannot change them, and it
 * publishes only while its configuration is still the latest one requested.
 * Every published entry pairs a source with its own formatted output under that
 * configuration, so whichever overlapping call publishes last leaves a valid
 * cache.
 */
export const createFormattedArtifactCache = (formatBatch: FormatBatch) => {
  let latestConfiguration: string | undefined;
  let cache = new Map<string, { raw: string; formatted: string }>();
  return async (
    artifacts: ReadonlyMap<string, string>,
    configuration: string,
  ): Promise<Map<string, string>> => {
    if (configuration !== latestConfiguration) {
      cache = new Map();
      latestConfiguration = configuration;
    }
    const reused = new Map<string, string>();
    const pending = new Map<string, string>();
    for (const [fileName, raw] of artifacts) {
      const entry = cache.get(fileName);
      if (entry?.raw === raw) {
        reused.set(fileName, entry.formatted);
      } else {
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
        : reused.get(fileName);
      if (output === undefined) {
        return panic(`Formatter returned no output for ${fileName}`);
      }
      next.set(fileName, { raw, formatted: output });
      formatted.set(fileName, output);
    }
    if (configuration === latestConfiguration) {
      cache = next;
    }
    return formatted;
  };
};
