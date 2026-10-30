import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-network-in-transaction", () => {
  test("reports network and object-storage awaits in transaction callbacks", async () => {
    expect(
      await lintSingleRule(
        "no-network-in-transaction",
        'import { GetObjectCommand } from "@aws-sdk/client-s3";\nasync function save() { await db.transaction(async (tx) => { await fetch(url); await s3.send(new GetObjectCommand({ Key: "key" })); }); }',
      ),
    ).toEqual([2, 2]);
  });

  test("reports imported clients and transparent Result callbacks", async () => {
    expect(
      await lintSingleRule(
        "no-network-in-transaction",
        'import { api } from "@/lib/api";\nasync function save() { await db.transaction(async () => { await Result.tryPromise(async () => await api.documents.list.get()); }); }',
      ),
    ).toEqual([2]);
  });

  test("accepts I/O before and after a transaction", async () => {
    expect(
      await lintSingleRule(
        "no-network-in-transaction",
        "async function save() { const response = await fetch(url); await db.transaction(async (tx) => { await tx.insert(values); }); await fetch(response.url); }",
      ),
    ).toEqual([]);
  });

  test("accepts deferred nested callbacks", async () => {
    expect(
      await lintSingleRule(
        "no-network-in-transaction",
        "async function save() { await db.transaction(async () => { const later = async () => await fetch(url); queue(later); }); }",
      ),
    ).toEqual([]);
  });
});
