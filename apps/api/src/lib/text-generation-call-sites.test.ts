import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  PENDING_TEXT_CALL_SITES,
  PENDING_TEXT_REFERENCES,
  TEXT_CALL_SITE_DRIVERS,
} from "@/api/tests/helpers/ai-text-call-sites";
import {
  discoverTextCallSites,
  installTextReplay,
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
  test("every call site is replayed or pending, by its runtime references", () => {
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
    expect(registered).toEqual(Object.fromEntries(discoverTextCallSites()));
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

  test("the scan counts calls and injected defaults, not imports or types", () => {
    // Guards the scan itself: one that stopped matching would pass the
    // census on an empty set.
    const discovered = discoverTextCallSites();
    expect(discovered.get("handlers/chat/compaction.ts")).toBe(2);
    expect(discovered.get("handlers/chat/suggest-thread-title.ts")).toBe(1);
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
