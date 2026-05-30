import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

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

export const CostBadge = ({ cost }: { cost: Cost }) => {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium",
        cost === "free" && "bg-emerald-100 text-emerald-800",
        cost === "paid" && "bg-amber-100 text-amber-800",
      )}
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

export const FirstPartyBadge = () => {
  const t = useTranslations();
  return (
    <span className="bg-foreground text-background inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium">
      {t("catalogue.firstParty")}
    </span>
  );
};

export const RecommendedBadge = () => {
  const t = useTranslations();
  return (
    <span className="border-foreground inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium">
      {t("catalogue.recommended")}
    </span>
  );
};
