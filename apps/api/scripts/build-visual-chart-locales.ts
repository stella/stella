import { readdir } from "node:fs/promises";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import { formattedLikeRepository } from "../../../scripts/generated-artifacts";

const source = new URL("../../web/src/i18n/langs/", import.meta.url);
const schema = v.object({
  caseLaw: v.object({
    courtTiers: v.record(
      v.picklist(COURT_TIER_LABELS),
      v.pipe(v.string(), v.minLength(1)),
    ),
  }),
});
const locales = (await readdir(source))
  .filter((name) => name.endsWith(".json"))
  .toSorted();
const entries = await Promise.all(
  locales.map(async (name) => {
    const catalog = v.parse(
      schema,
      await Bun.file(new URL(name, source)).json(),
    );
    return [name.slice(0, -5), catalog.caseLaw.courtTiers] as const;
  }),
);
await Bun.write(
  new URL(
    "../src/handlers/visual-sandbox/generated/court-tier-labels.json",
    import.meta.url,
  ),
  await formattedLikeRepository(
    JSON.stringify(Object.fromEntries(entries)),
    "json",
  ),
);
