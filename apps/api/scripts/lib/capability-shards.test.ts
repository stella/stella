import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  serializeCapabilityShard,
  syncCapabilityShards,
} from "./capability-shards";

test("shard bytes preserve arrays and do not depend on object insertion order", () => {
  const first = {
    id: "widgets.list",
    inputSchema: { z: ["second", "first"], a: { z: 1, a: 2 } },
  };
  const reordered = {
    inputSchema: { a: { a: 2, z: 1 }, z: ["second", "first"] },
    id: "widgets.list",
  };
  const serialized = serializeCapabilityShard(first);
  expect(serialized).toBe(serializeCapabilityShard(reordered));
  expect(JSON.parse(serialized)).toEqual(first);
  expect(serialized).toBe(
    '{"id":"widgets.list","inputSchema":{"a":{"a":2,"z":1},"z":["second","first"]}}\n',
  );
});

test("regeneration reaches a fixed point and checks reject stale, missing and mutated shards", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capability-shards-"));
  const shards = new Map([
    ["widgets.list.json", serializeCapabilityShard({ id: "widgets.list" })],
  ]);
  try {
    expect(
      await syncCapabilityShards({ directory, shards, mode: "check" }),
    ).toEqual(["widgets.list.json"]);
    await syncCapabilityShards({ directory, shards, mode: "write" });
    const first = await readFile(
      path.join(directory, "widgets.list.json"),
      "utf-8",
    );
    expect(
      await syncCapabilityShards({ directory, shards, mode: "write" }),
    ).toEqual([]);
    expect(
      await readFile(path.join(directory, "widgets.list.json"), "utf-8"),
    ).toBe(first);
    await writeFile(
      path.join(directory, "widgets.removed.json"),
      serializeCapabilityShard({ id: "widgets.removed" }),
    );
    expect(
      await syncCapabilityShards({ directory, shards, mode: "check" }),
    ).toEqual(["widgets.removed.json"]);
    await writeFile(path.join(directory, "widgets.list.json"), `${first} `);
    expect(
      await syncCapabilityShards({ directory, shards, mode: "check" }),
    ).toEqual(["widgets.list.json", "widgets.removed.json"]);
    await syncCapabilityShards({ directory, shards, mode: "write" });
    expect(
      await syncCapabilityShards({ directory, shards, mode: "check" }),
    ).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
