import { afterAll, describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { EMBEDDABLE_FRAME_HEADERS } from "./security-headers";

const HANDLER_ROOT = new URL("../handlers/", import.meta.url);
/**
 * A response that states its own Content-Security-Policy replaces the API's
 * frame denial whenever that policy names `frame-ancestors` (see
 * `securityHeaders`), so a handler that sets the header serves a page meant
 * to be framed.
 */
const STATES_OWN_POLICY = '"Content-Security-Policy":';
const USES_FRAME_HEADERS = "...EMBEDDABLE_FRAME_HEADERS";

/** A handler that states its own document policy serves an embeddable page. */
const embeddableHandlerProblems = (
  sources: ReadonlyMap<string, string>,
): string[] =>
  [...sources]
    .filter(([, source]) => source.includes(STATES_OWN_POLICY))
    .filter(([, source]) => !source.includes(USES_FRAME_HEADERS))
    .map(([path]) => path)
    .toSorted();

const handlerSources = async (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  const glob = new Bun.Glob("**/*.ts");
  for await (const path of glob.scan({ cwd: HANDLER_ROOT.pathname })) {
    if (path.endsWith(".test.ts")) {
      continue;
    }
    sources.set(path, await Bun.file(new URL(path, HANDLER_ROOT)).text());
  }
  return sources;
};

const server = serveForTest(apiApp);
afterAll(async () => {
  await server.stop();
});

describe("embeddable frame headers", () => {
  test("every handler that allows framing sends the embedder headers", async () => {
    const sources = await handlerSources();
    const embeddable = [...sources].filter(([, source]) =>
      source.includes(STATES_OWN_POLICY),
    );
    expect(embeddable.length).toBeGreaterThanOrEqual(2);
    expect(embeddableHandlerProblems(sources)).toEqual([]);
  });

  test("the census reports a framable handler without the headers", () => {
    expect(
      embeddableHandlerProblems(
        new Map([
          ["framed/routes.ts", `headers: { ${STATES_OWN_POLICY} policy }`],
          [
            "covered/routes.ts",
            `headers: { ${STATES_OWN_POLICY} policy, ${USES_FRAME_HEADERS} }`,
          ],
          ["plain/routes.ts", "return new Response('ok');"],
        ]),
      ),
    ).toEqual(["framed/routes.ts"]);
  });

  test.each(["/visual-sandbox", "/mcp-app-sandbox"])(
    "%s sends the embedder headers and lifts the frame denial",
    async (path) => {
      const response = await server.fetch(`http://localhost${path}`);
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(EMBEDDABLE_FRAME_HEADERS)) {
        expect(response.headers.get(name)).toBe(value);
      }
      // The document names who may frame it; the API's blanket denial would
      // override that in every browser that honours both.
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors",
      );
      expect(response.headers.get("x-frame-options")).toBeNull();
    },
  );

  test("an ordinary answer keeps the frame denial", async () => {
    const response = await server.fetch("http://localhost/live");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
