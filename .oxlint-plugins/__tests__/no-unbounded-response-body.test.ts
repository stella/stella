import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-unbounded-response-body", lines.join("\n"));

describe.serial("no-unbounded-response-body", () => {
  test("reports every body read on a fetch response", async () => {
    expect(
      await lint([
        "const a = await (await fetch(url)).arrayBuffer();",
        "const response = await fetchWithTimeout(url, init);",
        "const b = await response.text();",
        "const c = await response.clone().json();",
        "const d = await (await globalThis.fetch(url)).blob();",
        "const e = await (await fetchPublisher(url, init)).bytes();",
        "const f = await (await fetchWithRetry(url, init, opts)).json();",
        "",
      ]),
    ).toEqual([1, 3, 4, 5, 6, 7]);
  });

  test("follows declared Response types and parallel requests", async () => {
    expect(
      await lint([
        "const call = async (): Promise<Response> => await fetch(url);",
        "const g = await (await call()).json();",
        "const read = async (upstream: Response) => await upstream.text();",
        "const [first, second] = await Promise.all([fetch(a), fetch(b)]);",
        "const h = await second.json();",
        "async function load(): Promise<Response | null> { return await fetch(url); }",
        "const i = await (await load())?.text();",
        "",
      ]),
    ).toEqual([2, 3, 5, 7]);
  });

  test("drops a destructured response once the binding is reassigned", async () => {
    expect(
      await lint([
        "let [response] = await Promise.all([fetch(url)]);",
        "response = new Response(localStream);",
        "const text = await response.text();",
        "",
      ]),
    ).toEqual([]);
  });

  test("reports unbounded storage readers imported from the owner", async () => {
    expect(
      await lint([
        'import { readS3ArrayBuffer, readS3ObjectBounded } from "@/api/lib/s3";',
        "const whole = await readS3ArrayBuffer(key, signal);",
        "const capped = await readS3ObjectBounded({ bucket, key, maxBytes, signal });",
        "const sdk = await output.Body.transformToByteArray();",
        "",
      ]),
    ).toEqual([2, 4]);
  });

  test("ignores requests, uploads, local bodies, and unknown receivers", async () => {
    expect(
      await lint([
        "const r = await request.arrayBuffer();",
        "const u = await body.file.arrayBuffer();",
        "const l = await Bun.file(path).text();",
        "const s = await new Response(subprocess.stdout).text();",
        "const c = $(element).text();",
        "const readS3ArrayBuffer = async () => new ArrayBuffer(0);",
        "const local = await readS3ArrayBuffer();",
        "const shadow = async (response: Blob) => await response.text();",
        "let swapped = await fetch(url);",
        "swapped = new Response('x');",
        "const t = await swapped.text();",
        "",
      ]),
    ).toEqual([]);
  });
});
