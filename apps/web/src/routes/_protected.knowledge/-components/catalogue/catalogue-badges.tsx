import { useTranslations } from "use-intl";

import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";

type Cost = "free" | "paid";
type Setup = "none" | "account" | "api-key";

const COST_LABEL_KEY = {
  free: "catalogue.cost.free",
  paid: "catalogue.cost.paid",
} as const satisfies Record<Cost, TranslationKey>;

const SETUP_LABEL_KEY = {
  none: "catalogue.setup.none",
  account: "catalogue.setup.account",
  "api-key": "catalogue.setup.apiKey",
} as const satisfies Record<Setup, TranslationKey>;

export const CostBadge = ({ cost }: { cost: Cost | null }) => {
  const t = useTranslations();
  if (cost === null) {
    return null;
  }
  const tone =
    cost === "free"
      ? "bg-success/12 text-success"
      : "bg-warning/12 text-warning-foreground";
  return (
    <span
      className={`${tone} inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium`}
    >
      {t(COST_LABEL_KEY[cost])}
    </span>
  );
};

/**
 * Setup chip — only renders when something more than "out of the box"
 * is required. Reduces visual noise on the free/no-setup rows that
 * dominate the catalogue.
 */
export const SetupBadge = ({ setup }: { setup: Setup }) => {
  const t = useTranslations();
  if (setup === "none") {
    return null;
  }
  return (
    <span className="border-border text-muted-foreground inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium">
      {t(SETUP_LABEL_KEY[setup])}
    </span>
  );
};

export const LicenseBadge = ({ license }: { license: string }) => (
  <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium">
    {license}
  </span>
);

/**
 * First-party mark — the Stella brand glyph next to the title.
 * Used on the settings catalogue browser; onboarding still uses the
 * pill-shaped FirstPartyBadge below so its row can mirror the third-
 * party detail-panel emphasis.
 */
export const FirstPartyMark = () => {
  const t = useTranslations();
  return (
    <Tooltip
      content={t("catalogue.firstPartyTooltip")}
      render={
        <span aria-label={t("catalogue.firstParty")} className="inline-flex">
          <StellaMark className="text-foreground-muted size-3.5 shrink-0" />
        </span>
      }
    />
  );
};

export const FirstPartyBadge = () => {
  const t = useTranslations();
  return (
    <span className="bg-foreground text-background inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium">
      {t("catalogue.firstParty")}
    </span>
  );
};
