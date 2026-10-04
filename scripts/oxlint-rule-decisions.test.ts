// Guard: preset rules this repository keeps off on purpose stay off, however
// the presets and oxlint.config.ts combine.

import { expect, test } from "bun:test";

import config from "../oxlint.config.ts";
import {
  SEVERITY,
  declaredBaseRules,
  flattenLayers,
} from "./oxlint-effective-config.ts";
import { builtinRules, ruleCanonicalizer } from "./oxlint-rule-ids.ts";

test("keeps oxc/no-map-spread off: object spread is the one record-copy form", () => {
  const builtins = builtinRules();
  const { rules } = declaredBaseRules({
    layers: flattenLayers(config, "oxlint.config.ts"),
    builtins,
    canonical: ruleCanonicalizer(builtins),
  });

  expect(rules.get("oxc/no-map-spread")?.severity ?? SEVERITY.off).toBe(
    SEVERITY.off,
  );
});
