import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const RULE = "no-failure-as-empty";
const lint = async (lines: readonly string[]) =>
  await lintSingleRule(RULE, lines.join("\n"), {
    sourcePath: "apps/api/src/handlers/example.ts",
  });

describe.serial("failed reads stay distinct from empty results", () => {
  test("rejects catch clauses that return an empty value from a read", async () => {
    expect(
      await lint([
        "const a = async () => { try { return await load(); } catch { return []; } };",
        "const b = async () => { try { return await load(); } catch (error) { log(error); return null; } };",
        "const c = async () => { try { return await load(); } catch { return undefined; } };",
        "const d = async () => { try { await probe(); return true; } catch { return false; } };",
        "const e = async () => { try { return await load(); } catch { return { items: [], total: 0 }; } };",
        "const f = async (c) => { try { return c.json(await load()); } catch { return c.json([]); } };",
        "const g = async () => { try { return await load(); } catch { return new Map(); } };",
        "const h = async (signal) => { try { return await load(); } catch (error) { if (signal.aborted) throw error; return undefined; } };",
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("rejects failed-response branches that return an empty value", async () => {
    expect(
      await lint([
        "const a = async () => { const r = await fetch(u); if (!r.ok) return undefined; return r; };",
        "const b = async () => { const r = await fetch(u); if (!r.ok || r.status === 204) { return undefined; } return r; };",
        "const c = async () => { const r = await fetch(u); if (r.status !== 200) { return null; } return r; };",
        "const d = async () => { const r = await fetch(u); if (r.status >= 400) return []; return r; };",
        "const e = async () => { const r = await read(); if (Result.isError(r)) return []; return r.value; };",
        "const f = async () => { const r = await read(); if (r.isErr()) { return null; } return r.value; };",
        "const g = async () => { const r = await fetch(u); if (r.status === 500) return []; return r; };",
        "const h = async () => { const r = await fetch(u); if (403 === r.status) { return null; } return r; };",
        "const i = async () => { const r = await fetch(u); if (r.status == 429) return undefined; return r; };",
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("rejects promise and Result handlers that map a failure to an empty value", async () => {
    expect(
      await lint([
        "const a = async () => await load().catch(() => []);",
        "const b = async () => { const value = await load().catch(() => {}); return value; };",
        "const c = async () => await load().catch(() => { return null; });",
        "const d = async () => (await Result.tryPromise({ try: load, catch: () => undefined })).unwrapOr(undefined);",
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  test("permits parsing, propagation, stated absence and typed outcomes", async () => {
    expect(
      await lint([
        "const a = (raw) => { try { return JSON.parse(raw); } catch { return null; } };",
        'const b = async () => { try { return await load(); } catch (error) { if (isNotFound(error)) return readAbsent("http-404"); throw error; } };',
        "const c = async () => { const r = await fetch(u); if (r.status === 404) return null; if (!r.ok) throw new Error(); return r; };",
        'const d = async () => { try { return { type: "present", value: await load() }; } catch (cause) { return { type: "unavailable", cause }; } };',
        "const e = async () => { load().catch(() => {}); };",
        "const f = async () => { await load().catch((error) => { throw wrap(error); }); };",
        'const g = async () => { const r = await fetch(u); if (!r.ok) return { type: "unavailable", status: r.status }; return r; };',
        "const h = async () => { const r = await fetch(u); if (r.status === 200) return []; return r; };",
        "const i = async () => { const r = await fetch(u); if (r.status === 410) return null; if (!r.ok) throw new Error(); return r; };",
      ]),
    ).toEqual([]);
  });

  test("baselined sites are only exempt by their exact key", async () => {
    // The census option ignores the baseline; the key names the function,
    // the shape and its ordinal there, never a line number.
    expect(
      await lintSingleRule(
        RULE,
        [
          "export async function readAll() {",
          "  try { return await load(); } catch { return []; }",
          "}",
        ].join("\n"),
        {
          sourcePath: "apps/api/src/handlers/example.ts",
          ruleOptions: { census: true },
        },
      ),
    ).toEqual([2]);
  });
});
