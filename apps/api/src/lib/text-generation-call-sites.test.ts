import { describe, expect, test } from "bun:test";
import path from "node:path";

import { env } from "@/api/env";
import {
  PENDING_TEXT_CALL_SITES,
  PENDING_TEXT_REFERENCES,
  TEXT_CALL_SITE_DRIVERS,
} from "@/api/tests/helpers/ai-text-call-sites";
import {
  discoverTextCallSites,
  installTextReplay,
  runtimeReferences,
  seamExportsOf,
} from "@/api/tests/helpers/ai-text-replay";
import {
  cassetteKey,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import { STRUCTURED_OUTPUT_ENTRY_POINTS } from "@/api/tests/helpers/structured-output-role-fixtures";
import { createTestState } from "@/api/tests/helpers/test-state";

// Every handler that reads a text generation's answer against every provider
// wire cassette: the real handler, generation seam, model resolution and
// adapter, with only `fetch` answered from the cassette. Each handler must
// answer as its generation's outcome says, which never includes an untyped
// throw, and the census keeps every call site of a text generation in the
// replay.

const cassettes = loadProviderWireCassettes();
const testState = createTestState({ file: import.meta.path, config: env });
const replayCassette = installTextReplay(testState);

describe("text generation call site census", () => {
  const textExports = new Set(seamExportsOf("text"));

  test("every call site is replayed or pending, by its runtime references", async () => {
    const registered = {
      ...Object.fromEntries(
        Object.entries(TEXT_CALL_SITE_DRIVERS).map(([file, drivers]) => [
          file,
          drivers.length,
        ]),
      ),
      ...PENDING_TEXT_CALL_SITES,
    };
    // A new call of a text generation needs a driver in
    // `tests/helpers/ai-text-call-sites.ts` that replays its handler.
    expect(registered).toEqual(
      Object.fromEntries(await discoverTextCallSites()),
    );
  });

  test("no call site is both replayed and pending", () => {
    expect(
      Object.keys(PENDING_TEXT_CALL_SITES).filter(
        (file) => file in TEXT_CALL_SITE_DRIVERS,
      ),
    ).toEqual([]);
  });

  test("the pending ledger only shrinks", () => {
    expect(
      Object.values(PENDING_TEXT_CALL_SITES).reduce(
        (total, references) => total + references,
        0,
      ),
    ).toBe(PENDING_TEXT_REFERENCES);
  });

  test("the scan counts calls and injected defaults, not imports or types", async () => {
    // Guards the scan itself: one that stopped matching would pass the
    // census on an empty set.
    const discovered = await discoverTextCallSites();
    expect(discovered.get("handlers/chat/compaction.ts")).toBe(2);
    expect(discovered.get("handlers/chat/suggest-thread-title.ts")).toBe(1);
  });

  test("an aliased seam import counts calls through its local binding", async () => {
    const source = `
      import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";
      await generate({});
    `;

    expect(await runtimeReferences("aliased.ts", source, textExports)).toBe(1);
  });

  test("a relative seam import counts like the path alias", async () => {
    const source = `
      import { generateTanStackTextForTask as generate } from "./tanstack-ai-generate";
      await generate({});
    `;

    expect(
      await runtimeReferences(
        path.join(import.meta.dir, "relative.ts"),
        source,
        textExports,
      ),
    ).toBe(1);
  });

  test("a namespace seam import counts calls through its exported member", async () => {
    const source = `
      import * as ai from "@/api/lib/tanstack-ai-generate";
      await ai.generateTanStackTextForTask({});
    `;

    expect(await runtimeReferences("namespace.ts", source, textExports)).toBe(
      1,
    );
  });

  test("a seam import passed in a dependency object is a reference", async () => {
    const source = `
      import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
      const deps = { generateTanStackTextForTask };
      await deps.generateTanStackTextForTask({});
    `;

    expect(await runtimeReferences("deps.ts", source, textExports)).toBe(1);
  });

  test("a local with a seam export name is not an imported reference", async () => {
    const source = `
      const generateTanStackTextForTask = () => "local";
      generateTanStackTextForTask();
    `;

    expect(await runtimeReferences("local.ts", source, textExports)).toBe(0);
  });

  test("every structured export of the seam is in the structured-output census", () => {
    expect(
      seamExportsOf("structured").filter(
        (name) =>
          !STRUCTURED_OUTPUT_ENTRY_POINTS.some((entry) => entry === name),
      ),
    ).toEqual([]);
  });
});

for (const [file, drivers] of Object.entries(TEXT_CALL_SITE_DRIVERS)) {
  for (const driver of drivers) {
    describe(`${file} ${driver.name} answers every provider answer as its outcome says`, () => {
      for (const cassette of cassettes) {
        test(cassetteKey(cassette), async () => {
          const { findings, got, want } = await replayCassette(
            driver,
            cassette,
          );
          expect(got).toEqual(want);
          // The handler sent exactly the requests the cassette answers.
          expect(findings).toEqual({ unconsumed: [], unexpected: [] });
        });
      }
    });
  }
}
