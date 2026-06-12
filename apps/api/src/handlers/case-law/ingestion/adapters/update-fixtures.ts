/**
 * Update adapter test fixtures from live APIs.
 *
 * Records a fresh first-page response from each adapter
 * and saves it to __fixtures__/ for use in unit tests.
 * Run this periodically (or after a source changes) to
 * keep fixtures in sync with real API responses.
 *
 * Usage:
 *   bun run apps/api/src/handlers/case-law/ingestion/adapters/update-fixtures.ts
 *   bun run apps/api/src/handlers/case-law/ingestion/adapters/update-fixtures.ts --adapter sk-courts
 */

import type { SyncPage } from "@/api/handlers/case-law/ingestion/adapter";
import {
  listAdapterKeys,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const writeStdoutLine = (message = ""): void => {
  process.stdout.write(`${message}\n`);
};

const writeStderrLine = (message = ""): void => {
  process.stderr.write(`${message}\n`);
};

type FixtureRecord = {
  /** Adapter key. */
  adapter: string;
  /** ISO timestamp of recording. */
  recordedAt: string;
  /** Raw fetchPage result (serialized SyncPage). */
  page: SyncPage;
};

const writeFixture = async (
  adapter: string,
  data: FixtureRecord,
): Promise<string> => {
  const filename = `${adapter}-page.json`;
  const path = new URL(filename, FIXTURES_DIR);
  const content = JSON.stringify(data, null, 2);
  await Bun.write(path, content);
  return filename;
};

const updateAdapter = async (
  adapterKey: string,
): Promise<{ filename: string; count: number } | { error: string }> => {
  try {
    const adapter = await loadAdapterByKey(adapterKey);

    if (!adapter) {
      return { error: `Unknown adapter: ${adapterKey}` };
    }
    // Generous budget: adapters that rate-limit per-decision detail
    // fetches (cz-us) need several minutes for a full first page, and a
    // truncated capture weakens the fixture-based parser coverage.
    const result = await adapter.fetchPage(
      null,
      {},
      AbortSignal.timeout(600_000),
    );

    if (result.isErr()) {
      return {
        error: `${adapterKey}: ${result.error.message}`,
      };
    }

    const page = result.unwrap();
    const record: FixtureRecord = {
      adapter: adapterKey,
      recordedAt: new Date().toISOString(),
      page: {
        decisions: page.decisions,
        nextCursor: page.nextCursor,
      },
    };

    const filename = await writeFixture(adapterKey, record);
    return { filename, count: page.decisions.length };
  } catch (error) {
    return {
      error: `${adapterKey}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const adapterFlag = args.indexOf("--adapter");
  const rawTarget = adapterFlag !== -1 ? args[adapterFlag + 1] : undefined;

  const allKeys = listAdapterKeys();

  if (adapterFlag !== -1 && !rawTarget) {
    writeStderrLine("--adapter requires a value");
    writeStderrLine(`Available: ${allKeys.join(", ")}`);
    process.exit(1);
  }

  const targetAdapter = rawTarget;
  const keysToUpdate = targetAdapter
    ? allKeys.filter((k) => k === targetAdapter)
    : allKeys;

  if (keysToUpdate.length === 0) {
    writeStderrLine(
      targetAdapter
        ? `Unknown adapter: ${targetAdapter}`
        : "No adapters registered",
    );
    writeStderrLine(`Available: ${allKeys.join(", ")}`);
    process.exit(1);
  }

  writeStdoutLine(`Updating fixtures for ${keysToUpdate.length} adapter(s)...`);
  writeStdoutLine();

  let failures = 0;
  for (const [i, key] of keysToUpdate.entries()) {
    process.stdout.write(`  ${key}... `);
    const result = await updateAdapter(key);

    if ("error" in result) {
      writeStdoutLine(`FAILED: ${result.error}`);
      failures++;
    } else {
      writeStdoutLine(`OK (${result.count} decisions → ${result.filename})`);
    }

    // Rate limit between adapters
    if (i < keysToUpdate.length - 1) {
      await Bun.sleep(2000);
    }
  }

  writeStdoutLine(
    `\n${keysToUpdate.length - failures}/${keysToUpdate.length} updated`,
  );
  if (failures > 0) {
    process.exit(1);
  }
}

export { updateAdapter };
