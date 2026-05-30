import { describe, expect, test } from "bun:test";

import {
  createCatalogueAutoSelectionPlan,
  createCatalogueSetupPlan,
  reconcileCatalogueSlugsForJurisdictions,
} from "@/routes/onboarding/-components/onboarding-catalogue-setup.logic";

const nativeTool = (slug: string, options: { pinned?: boolean } = {}) => ({
  backendSlug: slug,
  kind: "native-tool" as const,
  pinned: options.pinned ?? false,
  slug,
});

const entries = [
  nativeTool("ares"),
  nativeTool("infosoud"),
  nativeTool("boe"),
  nativeTool("create-docx", { pinned: true }),
  { kind: "skill" as const, slug: "summarise-contract" },
];

const selectionEntries = [
  { jurisdictions: ["CZ"], slug: "ares" },
  { jurisdictions: ["CZ"], slug: "infosoud" },
  { jurisdictions: ["ES"], slug: "boe" },
  { jurisdictions: ["EU"], slug: "eur-lex" },
  { jurisdictions: [], slug: "summarise-contract" },
];

describe("onboarding catalogue setup plan", () => {
  test("persists opt-outs for omitted default native tools", () => {
    const plan = createCatalogueSetupPlan({
      entries,
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      selectedSlugs: [],
    });

    expect(plan.installSlugs).toEqual([]);
    expect(plan.nativeToolOptOuts).toEqual([
      { backendSlug: "ares", slug: "ares" },
      { backendSlug: "infosoud", slug: "infosoud" },
    ]);
  });

  test("does not opt out selected recommended native tools", () => {
    const plan = createCatalogueSetupPlan({
      entries,
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      selectedSlugs: ["ares", "ares", "summarise-contract"],
    });

    expect(plan.installSlugs).toEqual(["ares", "summarise-contract"]);
    expect(plan.nativeToolOptOuts).toEqual([
      { backendSlug: "infosoud", slug: "infosoud" },
    ]);
  });

  test("ignores pinned baseline entries when computing opt-outs", () => {
    const plan = createCatalogueSetupPlan({
      entries: [nativeTool("ares", { pinned: true })],
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      selectedSlugs: [],
    });

    expect(plan.nativeToolOptOuts).toEqual([]);
  });
});

describe("onboarding catalogue selection reconciliation", () => {
  test("drops stale jurisdiction picks after switching practice country", () => {
    const slugs = reconcileCatalogueSlugsForJurisdictions({
      entries: selectionEntries,
      practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
      selectedSlugs: [
        "ares",
        "infosoud",
        "boe",
        "eur-lex",
        "summarise-contract",
        "ares",
      ],
    });

    expect(slugs).toEqual(["boe", "eur-lex", "summarise-contract"]);
  });

  test("clears jurisdiction-specific picks when practice countries are skipped", () => {
    const slugs = reconcileCatalogueSlugsForJurisdictions({
      entries: selectionEntries,
      practiceJurisdictions: [],
      selectedSlugs: ["ares", "summarise-contract"],
    });

    expect(slugs).toEqual(["summarise-contract"]);
  });
});

describe("onboarding catalogue auto-selection", () => {
  test("adds first-party recommendations that have not been removed", () => {
    const plan = createCatalogueAutoSelectionPlan({
      recommendedEntries: [
        { author: "stella", slug: "ares" },
        { author: "community", slug: "third-party-tool" },
        { author: "stella", slug: "infosoud" },
      ],
      removedSlugs: ["infosoud"],
      selectedSlugs: ["summarise-contract"],
    });

    expect(plan).toEqual({
      addedSlugs: ["ares"],
      selectedSlugs: ["summarise-contract", "ares"],
    });
  });

  test("does not re-add a removed recommendation after remount", () => {
    const plan = createCatalogueAutoSelectionPlan({
      recommendedEntries: [{ author: "stella", slug: "ares" }],
      removedSlugs: ["ares"],
      selectedSlugs: [],
    });

    expect(plan).toEqual({
      addedSlugs: [],
      selectedSlugs: [],
    });
  });
});
