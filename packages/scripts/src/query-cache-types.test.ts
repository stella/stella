import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SourceFile } from "tsrs/unstable/ast";

import { scanQueryCacheTypes } from "./query-cache-types";
import { createProgram } from "./typescript-program";

// Both fixture modules resolve the installed library, including its unique tag
// symbols. An imported plain object still compiles, which is the guard's boundary.
test("exact cache access retains the producer's tag across module boundaries", async () => {
  const cacheDirectory = path.join(import.meta.dir, "../.cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const directory = mkdtempSync(path.join(cacheDirectory, "query-cache-test-"));
  const producer = `
    import { queryOptions, infiniteQueryOptions } from '@tanstack/react-query';
    export const tagged = () => queryOptions({ queryKey: ['items'], queryFn: async () => [1] });
    export const plain = () => ({ queryKey: ['items'], queryFn: async () => [1] });
    export const infinite = () => infiniteQueryOptions({
      queryKey: ['pages'], queryFn: async () => [1], initialPageParam: 0,
      getNextPageParam: () => undefined,
    });
  `;
  const consumer = `
    import { QueryClient, type DataTag, type QueryKey } from '@tanstack/react-query';
    import { tagged, plain, infinite } from './producer';
    const client = new QueryClient();
    const key = tagged().queryKey;
    const { queryKey: destructured } = tagged();
    client.getQueryData(key);
    client.setQueryData(destructured, [2]);
    client.getQueryData(infinite().queryKey);
    function generic<T>(key: DataTag<QueryKey, T>) { client.getQueryData(key); }
    const plainKey = plain().queryKey;
    client.getQueryData(plainKey); // reject
    client['setQueryData'](plainKey, 'wrong shape'); // reject
    const widened: QueryKey = key;
    client.getQueryData(widened); // reject
    const erased: any = key;
    client.setQueryData(erased, 'wrong shape'); // reject
    const conditional = Math.random() ? key : plainKey;
    client.getQueryData(conditional); // reject
    const unrelated = { getQueryData: (key: string[]) => key };
    unrelated.getQueryData(['unrelated']);
    client.invalidateQueries({ queryKey: ['items'] });
  `;
  let opened: Awaited<ReturnType<typeof createProgram>> | undefined;
  try {
    writeFileSync(path.join(directory, "producer.ts"), producer);
    const consumerFile = path.join(directory, "consumer.ts");
    writeFileSync(consumerFile, consumer);
    opened = await createProgram({
      rootNames: [consumerFile],
      compilerOptions: {
        module: "preserve",
        moduleResolution: "bundler",
        skipLibCheck: true,
        strict: true,
        target: "esnext",
      },
    });
    const { program } = opened;
    expect(await program.getSemanticDiagnostics()).toEqual([]);
    const sourceFiles: SourceFile[] = [];
    for (const fileName of await program.getSourceFileNames()) {
      if (!fileName.startsWith(directory)) {
        continue;
      }
      const file = await program.getSourceFile(fileName);
      if (file !== undefined) {
        sourceFiles.push(file);
      }
    }
    const expectedLines = consumer
      .split("\n")
      .flatMap((line, index) =>
        line.includes("// reject") ? [index + 1] : [],
      );
    expect(expectedLines).toHaveLength(5);
    const diagnostics = await scanQueryCacheTypes({ ...opened, sourceFiles });
    expect(diagnostics.map(({ line }) => line)).toEqual(expectedLines);
    expect(diagnostics.every(({ file }) => file === consumerFile)).toBe(true);
  } finally {
    await opened?.close();
    rmSync(directory, { force: true, recursive: true });
  }
}, 30_000);
