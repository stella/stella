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

import {
  listAdapterKeys,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

type FixtureRecord = {
  /** Adapter key. */
  adapter: string;
  /** ISO timestamp of recording. */
  recordedAt: string;
  /** Raw fetchPage result (serialized SyncPage). */
  page: {
    decisions: unknown[];
    nextCursor: string | null;
  };
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
    const result = await adapter.fetchPage(
      null,
      {},
      AbortSignal.timeout(120_000),
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
    console.error("--adapter requires a value");
    console.error("Available:", allKeys.join(", "));
    process.exit(1);
  }

  const targetAdapter = rawTarget;
  const keysToUpdate = targetAdapter
    ? allKeys.filter((k) => k === targetAdapter)
    : allKeys;

  if (keysToUpdate.length === 0) {
    console.error(
      targetAdapter
        ? `Unknown adapter: ${targetAdapter}`
        : "No adapters registered",
    );
    console.error("Available:", allKeys.join(", "));
    process.exit(1);
  }

  console.log(`Updating fixtures for ${keysToUpdate.length} adapter(s)...\n`);

  let failures = 0;
  for (let i = 0; i < keysToUpdate.length; i++) {
    const key = keysToUpdate[i];
    process.stdout.write(`  ${key}... `);
    const result = await updateAdapter(key);

    if ("error" in result) {
      console.log(`FAILED: ${result.error}`);
      failures++;
    } else {
      console.log(`OK (${result.count} decisions → ${result.filename})`);
    }

    // Rate limit between adapters
    if (i < keysToUpdate.length - 1) {
      await Bun.sleep(2000);
    }
  }

  console.log(
    `\n${keysToUpdate.length - failures}/${keysToUpdate.length} updated`,
  );
  if (failures > 0) {
    process.exit(1);
  }
}

export { updateAdapter };
