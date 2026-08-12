import { describe, expect, test } from "bun:test";
import path from "node:path";

const LANDING_GRADIENT_DIRECTORY = path.resolve(
  import.meta.dir,
  "../../../../../landing/public/images/gradients",
);
const WEB_BRANDING_DIRECTORY = path.resolve(
  import.meta.dir,
  "../../../../public/branding",
);

describe("onboarding gradient assets", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} gradient matches the landing source`, async () => {
      const landingGradient = await Bun.file(
        path.resolve(LANDING_GRADIENT_DIRECTORY, `hero-${theme}.svg`),
      ).text();
      const onboardingGradient = await Bun.file(
        path.resolve(
          WEB_BRANDING_DIRECTORY,
          `onboarding-gradient-${theme}.svg`,
        ),
      ).text();

      expect(onboardingGradient).toBe(landingGradient);
    });
  }
});
