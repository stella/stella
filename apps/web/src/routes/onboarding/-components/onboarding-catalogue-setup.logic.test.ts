import { describe, expect, test } from "bun:test";

import { createCatalogueSetupPlan } from "@/routes/onboarding/-components/onboarding-catalogue-setup.logic";

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
