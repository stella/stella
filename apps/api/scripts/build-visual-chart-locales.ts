import { COURT_TIER_LOCALIZED_LABELS } from "@stll/api-contract/case-law-court-tier-locales";

import { formattedLikeRepository } from "../../../scripts/generated-artifacts";

await Bun.write(
  new URL(
    "../src/handlers/visual-sandbox/generated/court-tier-labels.json",
    import.meta.url,
  ),
  await formattedLikeRepository(
    JSON.stringify(COURT_TIER_LOCALIZED_LABELS),
    "json",
  ),
);
