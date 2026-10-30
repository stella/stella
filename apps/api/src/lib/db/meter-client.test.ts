import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import { meterSqlClient } from "@/api/lib/db/meter-client";
import {
  currentReadWork,
  meterStorageRead,
  meterStorageReadStream,
  recordDbResult,
  recordReadWork,
} from "@/api/lib/observability/request-work";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const createClient = (rows: unknown) => {
  const query = async () => await Promise.resolve(rows);
  return Object.assign(query, { unsafe: query });
};

describe("request read work", () => {
  test("an absent raw driver result records no JSON payload bytes", () => {
    runWithQueryCounter(() => {
      recordDbResult(undefined);
      expect(currentReadWork()?.dbResultBytes).toBe(0);
    });
  });
  test("reusing an instrumented client retains one meter and one result count", async () => {
    const client = meterSqlClient(createClient([{ content: "text" }]));
    const reused = meterSqlClient(client);
    expect(reused).toBe(client);
    await runWithQueryCounter(async () => {
      expect(await reused.unsafe()).toEqual([{ content: "text" }]);
      expect(currentReadWork()?.dbResultBytes).toBe(20);
    });
  });

  test.each(["catch", "finally"] as const)(
    "native %s continuations meter successful rows",
    async (continuation) => {
      await withGatedTestClients(
        "sqlite://:memory:",
        async ({ openClient }) => {
          const client = meterSqlClient(openClient().sql);
          await runWithQueryCounter(async () => {
            const pending = client.unsafe("select 'text' as content");
            const rows =
              continuation === "catch"
                ? await pending.catch((error: unknown) =>
                    panic("Unexpected SQL failure", error),
                  )
                : await pending.finally(() => undefined);
            expect(rows).toEqual([{ content: "text" }]);
            expect(currentReadWork()?.dbResultBytes).toBe(20);
          });
        },
      );
    },
  );
  test.each(["successful", "failed"] as const)(
    "an asynchronous finalizer failure replaces a %s query outcome",
    async (outcome) => {
      await withGatedTestClients(
        "sqlite://:memory:",
        async ({ openClient }) => {
          const client = meterSqlClient(openClient().sql);
          const cleanupFailure = new Error("Asynchronous SQL cleanup failed");
          await runWithQueryCounter(async () => {
            const pending = client.unsafe(
              outcome === "successful"
                ? "select 'text' as content"
                : "select * from missing_cleanup_fixture",
            );
            // Promise.finally awaits thenables although its callback is typed void.
            const finalize: unknown = Reflect.get(pending, "finally");
            if (typeof finalize !== "function") {
              panic("Native SQL query needs a finalizer");
            }
            const finalized: unknown = Reflect.apply(finalize, pending, [
              async () => {
                await Promise.resolve();
                throw cleanupFailure;
              },
            ]);
            expect(await rejectionOf(Promise.resolve(finalized))).toBe(
              cleanupFailure,
            );
            expect(currentReadWork()?.dbResultBytes).toBe(
              outcome === "successful" ? 20 : 0,
            );
          });
        },
      );
    },
  );
  test("stream consumption remains attributed to the request that opened it", async () => {
    const opened = runWithQueryCounter((counter) => {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      });
      return { counter, stream: meterStorageReadStream(stream) };
    });
    expect(currentReadWork()).toBeUndefined();
    const bytes = await new Response(opened.stream).arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(opened.counter.storageReadBytes).toBe(3);
  });
  test("unmeasured streams retain their identity and measured streams reject non-byte chunks", async () => {
    const untouched = new ReadableStream<Uint8Array>();
    expect(meterStorageReadStream(untouched)).toBe(untouched);
    const invalid = runWithQueryCounter(() =>
      meterStorageReadStream(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue("not bytes");
            controller.close();
          },
        }),
      ),
    );
    expect(
      await rejectionOf(new Response(invalid).arrayBuffer()),
    ).toMatchObject({
      message: "Storage read stream yielded a non-byte chunk",
    });
  });
  test("transaction and savepoint queries share the caller meter", async () => {
    await withGatedTestClients("sqlite://:memory:", async ({ openClient }) => {
      const client = runTransactionsInCallerContext(openClient().sql);
      await runWithQueryCounter(async () => {
        await client.begin(async (transaction) => {
          await transaction`select ${"one"} as content`;
          await transaction.savepoint(async (savepoint) => {
            await savepoint`select ${"two"} as content`;
          });
        });
        expect(currentReadWork()?.dbResultBytes).toBe(38);
      });
    });
  });
  test("native queries preserve array mode and tagged reads", async () => {
    await withGatedTestClients("sqlite://:memory:", async ({ openClient }) => {
      const client = meterSqlClient(openClient().sql);
      await runWithQueryCounter(async () => {
        const rows = await client.unsafe("select 'ž' as content").values();
        expect(rows).toEqual([["ž"]]);
        expect(currentReadWork()?.dbResultBytes).toBe(8);
        const tagged = await client`select ${"text"} as content`;
        expect(tagged).toEqual([{ content: "text" }]);
        expect(currentReadWork()?.dbResultBytes).toBe(28);
      });
    });
  });
  test("driver bytes include projected-away columns and UTF-8 payloads", async () => {
    const rows = [["žluťoučký", { text: "x".repeat(8000) }]];
    const client = meterSqlClient(createClient(rows));
    await runWithQueryCounter(async () => {
      const result = await client.unsafe();
      expect(result).toEqual(rows);
      expect(currentReadWork()?.dbResultBytes).toBe(
        Buffer.byteLength(JSON.stringify(rows)),
      );
    });
    expect(currentReadWork()).toBeUndefined();
  });

  test("native queries remain lazy and count each result once", async () => {
    await withGatedTestClients("sqlite://:memory:", async ({ openClient }) => {
      const client = meterSqlClient(openClient().sql);
      await client.unsafe("create table items (content text)");
      const query = client.unsafe(
        "insert into items values ('payload') returning content",
      );
      const before = await client.unsafe("select count(*) as count from items");
      expect(before).toEqual([{ count: 0n }]);
      await query;
      await query;
      const after = await client.unsafe("select count(*) as count from items");
      expect(after).toEqual([{ count: 1n }]);
      await runWithQueryCounter(async () => {
        const pending = client.unsafe("select 'payload' as content");
        await pending;
        await pending;
        expect(currentReadWork()?.dbResultBytes).toBe(23);
      });
    });
  });

  test("concurrent stores isolate every measure and snapshots stay detached", async () => {
    const measure = async (amount: number) =>
      await runWithQueryCounter(async () => {
        const client = meterSqlClient(createClient([["x".repeat(amount)]]));
        const bytes = new Uint8Array(amount);
        expect(meterStorageRead(bytes)).toBe(bytes);
        recordReadWork("decryptedBytes", amount);
        recordReadWork("documentConversions");
        recordReadWork("astParses");
        const captured = currentReadWork();
        await Promise.resolve();
        await client();
        recordReadWork("cacheHits");
        expect(captured?.dbResultBytes).toBe(0);
        expect(captured?.cacheHits).toBe(0);
        return (
          currentReadWork() ?? panic("Measurement requires its request meter")
        );
      });
    const [small, large] = await Promise.all([measure(10), measure(100)]);
    expect(small).toEqual({
      storageReadBytes: 10,
      decryptedBytes: 10,
      astParses: 1,
      documentConversions: 1,
      dbResultBytes: 16,
      cacheHits: 1,
    });
    expect(large).toEqual({
      ...small,
      storageReadBytes: 100,
      decryptedBytes: 100,
      dbResultBytes: 106,
    });
  });
});
