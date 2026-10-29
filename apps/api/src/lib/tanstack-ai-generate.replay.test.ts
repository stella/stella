import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";
import { SEAM_DRIVERS } from "@/api/tests/helpers/ai-text-call-sites";
import { installTextReplay } from "@/api/tests/helpers/ai-text-replay";
import {
  cassetteKey,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import { createTestState } from "@/api/tests/helpers/test-state";

// The text generation seam against every provider wire cassette, under every
// finish policy: the recorded and synthetic provider answers through the real
// adapter and model resolution. Each answer must settle as the policy says (a
// success, a typed incomplete or refused answer, a typed failure), never as
// an untyped throw. Handlers that call the seam replay the same corpus in
// `text-generation-call-sites.test.ts`.

const cassettes = loadProviderWireCassettes();
const testState = createTestState({ file: import.meta.path, config: env });
const replayCassette = installTextReplay(testState);

/**
 * A cassette that ends in an error reports no finish for a policy to grade,
 * and the seam fails before it reads its policy, so one policy meets it.
 */
const ERROR_CASSETTE_POLICY =
  "require-complete" satisfies TanStackTextFinishPolicy;

for (const driver of Object.values(SEAM_DRIVERS)) {
  const graded = cassettes.filter(
    ({ expect: expected }) =>
      expected.outcome === "finished" ||
      driver.finishPolicy === ERROR_CASSETTE_POLICY,
  );
  describe(`${driver.name} settles every provider answer as its policy says`, () => {
    for (const cassette of graded) {
      test(cassetteKey(cassette), async () => {
        const { findings, got, want } = await replayCassette(driver, cassette);
        expect(got).toEqual(want);
        // The seam sent exactly the requests the cassette answers.
        expect(findings).toEqual({ unconsumed: [], unexpected: [] });
      });
    }
  });
}
