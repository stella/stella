import { describe, expect, test } from "bun:test";

import api from "@/api/server";

import { EMBEDDABLE_FRAME_HEADERS } from "./security-headers";

const HANDLER_ROOT = new URL("../handlers/", import.meta.url);
const LIFTS_FRAME_DENIAL = 'delete set.headers["X-Frame-Options"]';
const USES_FRAME_HEADERS = "...EMBEDDABLE_FRAME_HEADERS";

/** A handler that lifts the default frame denial serves an embeddable page. */
const embeddableHandlerProblems = (
  sources: ReadonlyMap<string, string>,
): string[] =>
  [...sources]
    .filter(([, source]) => source.includes(LIFTS_FRAME_DENIAL))
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

describe("embeddable frame headers", () => {
  test("every handler that allows framing sends the embedder headers", async () => {
    const sources = await handlerSources();
    const embeddable = [...sources].filter(([, source]) =>
      source.includes(LIFTS_FRAME_DENIAL),
    );
    expect(embeddable.length).toBeGreaterThanOrEqual(2);
    expect(embeddableHandlerProblems(sources)).toEqual([]);
  });

  test("the census reports a framable handler without the headers", () => {
    expect(
      embeddableHandlerProblems(
        new Map([
          ["framed/routes.ts", `${LIFTS_FRAME_DENIAL};`],
          [
            "covered/routes.ts",
            `${LIFTS_FRAME_DENIAL}; headers: { ${USES_FRAME_HEADERS} }`,
          ],
          ["plain/routes.ts", "return new Response('ok');"],
        ]),
      ),
    ).toEqual(["framed/routes.ts"]);
  });

  test.each(["/visual-sandbox", "/mcp-app-sandbox"])(
    "%s sends the embedder headers",
    async (path) => {
      const response = await api.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(EMBEDDABLE_FRAME_HEADERS)) {
        expect(response.headers.get(name)).toBe(value);
      }
    },
  );
});
