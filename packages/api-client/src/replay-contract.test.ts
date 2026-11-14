import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const declarations = `
import type { ApiClient } from "../src/index.ts";
type Route<H> = { body: { name: string }; params: unknown; query: unknown; headers: H; response: {200: {id: string}} };
type CurrentRoute = Route<{readonly "Idempotency-Key"?: never}>;
declare const api: ApiClient<{
  current: {post: CurrentRoute};
  replay: {post: Route<{readonly "Idempotency-Key"?: string}>};
}>;
const body = {name: "Created"};
`;

const checkContract = async (source: string) => {
  const directory = await mkdtemp(path.join(packageRoot, ".cache-replay-"));
  try {
    await writeFile(path.join(directory, "contract.ts"), declarations + source);
    const project = path.join(directory, "tsconfig.json");
    await writeFile(
      project,
      JSON.stringify({
        extends: path.join(packageRoot, "tsconfig.json"),
        files: ["contract.ts"],
        include: [],
        exclude: [],
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "check",
        "--no-pretty",
        "--all",
        `--project=${project}`,
      ],
      {
        cwd: packageRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status, output: stdout + stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test.each([
  'api.current.post(body, {headers: {"Idempotency-Key": "intent"}});',
  'const request = {headers: {"Idempotency-Key": "intent"}}; const alias = request; api.current.post(body, alias);',
  'const request = {headers: {"Idempotency-Key": "intent"}}; api.current.post(body, {...request});',
  'api.current.post(body, {fetch: {headers: {"Idempotency-Key": "intent"}}});',
  'api.current.post(body, {fetch: {headers: new Headers({"Idempotency-Key": "intent"})}});',
  'api.current.post(body, {fetch: {headers: [["Idempotency-Key", "intent"]]}});',
])("non-replay request types reject reserved headers: %s", async (source) => {
  const result = await checkContract(source);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/error TS(?:2322|2345)/u);
});

test("replay contracts retain inferred request and ordinary header types", async () => {
  const result = await checkContract(`
    declare const request: {headers: {"x-trace": string}} | {fetch: {signal: AbortSignal}};
    api.current.post(body, request);
    api.current.post(body);
    api.current.post(body, {headers: {"x-stella-capability": "things.create"}});
    api.current.post(body, {fetch: {signal: new AbortController().signal}});
    api.replay.post(body, {headers: {"iDeMpOtEnCy-KeY": "intent"}});
    api.replay.post(body, {fetch: {headers: new Headers({"idempotency-key": "intent"})}});
  `);
  expect(result.output).not.toContain("error TS");
  expect(result.status).toBe(0);
});
