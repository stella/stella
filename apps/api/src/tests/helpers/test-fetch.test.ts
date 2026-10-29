import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  installTestFetch,
  withTestFetch,
  withTestFetchInterceptor,
} from "./test-fetch";
import { asFetchMock } from "./test-tool-set";

test("fetch fixtures restore every test and unwind nested suite defaults", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-fetch-fixture-"));
  const owner = path.join(import.meta.dirname, "test-fetch.ts");
  const preload = path.join(import.meta.dirname, "../fetch-state-hooks.ts");
  const file = path.join(directory, "fixture.test.ts");
  try {
    writeFileSync(
      file,
      `import { afterAll, describe, expect, test } from "bun:test";
import { createTestFetch, installTestFetch, withTestFetch } from ${JSON.stringify(owner)};
const baseline = globalThis.fetch;
const fixture = createTestFetch();
const fake = (text) => Object.assign(async () => new Response(text), { preconnect() {} });
const outer = fake("outer");
const inner = fake("inner");
fixture.set(outer);
expect(globalThis.fetch).toBe(baseline);
const response = async () => await (await fetch("https://example.invalid")).text();
test("file default", async () => { expect(globalThis.fetch).toBe(outer); expect(await response()).toBe("outer"); fixture.set(fake("local")); expect(await response()).toBe("local"); });
test("local writes do not become defaults", () => { expect(globalThis.fetch).toBe(outer); });
describe("nested suite", () => {
  fixture.beforeAll(async () => {
    fixture.set(inner);
    expect(await response()).toBe("inner");
    await Promise.resolve();
    fixture.set(inner);
  });
  test("suite default", () => { expect(globalThis.fetch).toBe(inner); });
  describe("deeper suite", () => {
    fixture.beforeAll(() => { fixture.set(fake("deeper")); });
    test("deep default", async () => { expect(await response()).toBe("deeper"); });
  });
  test("nested default unwinds", () => { expect(globalThis.fetch).toBe(inner); });
});
test("suite default unwinds", () => { expect(globalThis.fetch).toBe(outer); });
describe("a suite without a fetch default", () => {
  fixture.beforeAll(() => {});
  test("inherits the file default", () => { expect(globalThis.fetch).toBe(outer); });
});
test("explicit restoration unwinds all local writes and permits reuse", () => {
  const local = fake("local");
  expect(fixture.set(local)).toBe(local);
  fixture.set(fake("last"));
  fixture.restore();
  expect(globalThis.fetch).toBe(baseline);
  fixture.restore();
  fixture.set(local);
  expect(globalThis.fetch).toBe(local);
});
test("scoped operation restores after rejection", async () => {
  await expect(withTestFetch(inner, async () => { throw new Error("fixture rejection"); })).rejects.toThrow("fixture rejection");
  expect(globalThis.fetch).toBe(outer);
});
test("restoration preserves a later owner's replacement", () => {
  const first = installTestFetch(inner);
  const second = installTestFetch(fake("second"));
  first.restore();
  expect(globalThis.fetch).not.toBe(outer);
  second.restore();
  expect(globalThis.fetch).toBe(inner);
  first.restore();
  expect(globalThis.fetch).toBe(outer);
});
afterAll(() => { expect(globalThis.fetch).toBe(baseline); });`,
    );
    const run = Bun.spawnSync({
      cmd: [process.execPath, "test", "--preload", preload, file],
      cwd: directory,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const output = run.stderr.toString();
    expect(run.exitCode, output).toBe(0);
    expect(output).toContain("10 pass");
    expect(output).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reinstalling a fetch owner captures its new surrounding scope", async () => {
  const baseline = globalThis.fetch;
  const first = asFetchMock(async () => new Response("first"));
  const second = asFetchMock(async () => new Response("second"));
  const owner = installTestFetch(first);
  try {
    owner.restore();
    expect(globalThis.fetch).toBe(baseline);
    await withTestFetch(second, async () => {
      owner.install();
      owner.install();
      expect(globalThis.fetch).toBe(first);
      owner.restore();
      expect(globalThis.fetch).toBe(second);
    });
    expect(globalThis.fetch).toBe(baseline);
  } finally {
    owner.restore();
  }
});

test("fetch interception restores the property descriptor after success and rejection", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const first = asFetchMock(async () => new Response("first"));
  const second = asFetchMock(async () => new Response("second"));
  const seen: string[] = [];
  const intercept = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    delegate: typeof fetch,
  ) => {
    const body = await (await delegate(input, init)).text();
    seen.push(body);
    return new Response(`intercepted ${body}`);
  };
  const read = async () =>
    await (await fetch("https://example.invalid")).text();

  const value = await withTestFetchInterceptor(intercept, async () => {
    const wrapper = globalThis.fetch;
    const firstOwner = installTestFetch(first);
    try {
      expect(globalThis.fetch).toBe(wrapper);
      expect(await read()).toBe("intercepted first");
      const secondOwner = installTestFetch(second);
      try {
        expect(globalThis.fetch).toBe(wrapper);
        expect(await read()).toBe("intercepted second");
      } finally {
        secondOwner.restore();
      }
    } finally {
      firstOwner.restore();
    }
    return "operation result";
  });
  expect(value).toBe("operation result");
  expect(seen).toEqual(["first", "second"]);
  expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(
    descriptor,
  );

  expect(
    await rejectionOf(
      withTestFetchInterceptor(intercept, async () => {
        installTestFetch(second);
        expect(await read()).toBe("intercepted second");
        throw new TypeError("intercepted operation failed");
      }),
    ),
  ).toMatchObject({ message: "intercepted operation failed" });
  expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(
    descriptor,
  );
});
