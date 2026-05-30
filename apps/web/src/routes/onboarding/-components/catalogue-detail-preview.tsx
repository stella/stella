import {
  AlertTriangleIcon,
  BanknoteIcon,
  ExternalLinkIcon,
  ScaleIcon,
  Settings2Icon,
  TagIcon,
  UserIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";

import { sanitizeHref } from "@/lib/sanitize-href";
import { CatalogueEntryIcon } from "@/routes/_protected.settings/-components/catalogue/catalogue-entry-icon";

/**
 * iOS Privacy-Nutritional-Label-style detail panel. Replaces the stack
 * preview on the right when the user focuses a catalogue row on the
 * left. Lists provenance, cost, setup, jurisdictions, and tags as
 * separate sections with hairline dividers; a single primary button
 * commits the choice (or removes if already installed). For
 * non-first-party entries, the third-party disclaimer renders inline
 * above the primary action — no modal popup.
 */
type CatalogueDetailPreviewProps = {
  entry: LoadedCatalogueEntry;
  installed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export const CatalogueDetailPreview = ({
  entry,
  installed,
  onConfirm,
  onCancel,
}: CatalogueDetailPreviewProps) => {
  const t = useTranslations();
  const isFirstParty = entry.author === "stella";

  return (
    <div className="flex h-full max-h-full w-full items-stretch justify-center overflow-hidden">
      <div className="bg-background border-border/40 relative flex h-full max-h-full w-full max-w-[340px] flex-col rounded-2xl border shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)]">
        <button
          aria-label={t("common.close")}
          className="text-muted-foreground hover:text-foreground absolute end-4 top-4 transition-colors"
          onClick={onCancel}
          type="button"
        >
          <XIcon className="size-5" />
        </button>

        {/* Header */}
        <header className="border-border flex items-center gap-3 border-b px-5 py-4">
          <CatalogueEntryIcon
            icon={entry.icon}
            iconUrl={entry.iconUrl ?? null}
            size={40}
            slug={entry.slug}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-foreground truncate text-base leading-tight font-semibold">
              {entry.displayName}
            </h2>
            <p className="text-muted-foreground text-xs tracking-wider uppercase">
              {t(`catalogue.filter.${kindToFilter(entry.kind)}`)}
            </p>
          </div>
        </header>

        {/* Body — description at top, metadata pinned at the bottom so
            the prose has breathing room. The whole body scrolls only
            when content overflows the available space. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          <Section title={t("onboarding.catalogueDetailAbout")}>
            <p className="text-foreground text-sm leading-relaxed">
              {entry.description}
            </p>
          </Section>

          <div className="mt-auto flex flex-col gap-5">
            <Divider />

            <Section title={t("onboarding.catalogueDetailProvenance")}>
              <div className="grid grid-cols-2 gap-3">
                <AuthorField
                  ariaLabel={t("onboarding.catalogueDetailAuthor")}
                  authorUrl={entry.authorUrl}
                  isFirstParty={isFirstParty}
                  value={
                    isFirstParty
                      ? t("onboarding.catalogueDetailFirstParty")
                      : entry.author
                  }
                />
                <Field
                  ariaLabel={t("onboarding.catalogueDetailLicense")}
                  icon={ScaleIcon}
                  value={entry.license}
                />
              </div>
            </Section>

            <Divider />

            <Section title={t("onboarding.catalogueDetailAccess")}>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  ariaLabel={t("onboarding.catalogueDetailCost")}
                  icon={BanknoteIcon}
                  value={t(`catalogue.cost.${entry.cost}`)}
                />
                <Field
                  ariaLabel={t("onboarding.catalogueDetailSetup")}
                  icon={Settings2Icon}
                  value={t(`catalogue.setup.${setupKey(entry.setup)}`)}
                />
              </div>
            </Section>

            {entry.jurisdictions.length > 0 && (
              <>
                <Divider />
                <Section title={t("onboarding.catalogueDetailCoverage")}>
                  <ChipRow
                    ariaLabel={t("onboarding.catalogueDetailJurisdictions")}
                    icon={TagIcon}
                    values={entry.jurisdictions}
                  />
                </Section>
              </>
            )}

            {!isFirstParty && (
              <div className="border-warning/40 bg-warning/10 flex gap-2 rounded-md border p-3">
                <AlertTriangleIcon className="text-warning-foreground mt-0.5 size-4 shrink-0" />
                <p className="text-warning-foreground text-xs leading-relaxed">
                  {t("onboarding.catalogueThirdPartyDisclaimer", {
                    author: entry.author,
                  })}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer with primary action */}
        <footer className="border-border flex flex-col gap-2 border-t px-5 py-4">
          {installed ? (
            <Button
              className="w-full"
              onClick={onConfirm}
              type="button"
              variant="destructive-outline"
            >
              {t("onboarding.catalogueDetailRemove")}
            </Button>
          ) : (
            <Button className="w-full" onClick={onConfirm} type="button">
              {isFirstParty
                ? t("onboarding.catalogueDetailAdd")
                : t("onboarding.catalogueThirdPartyConfirm")}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="flex flex-col gap-2.5">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
      {title}
    </h3>
    {children}
  </section>
);

/**
 * Icon + value, no redundant label. The icon and choice (e.g. 💵
 * "Zdarma") convey meaning together — "Cena" prefix is redundant.
 */
const Field = ({
  icon: Icon,
  ariaLabel,
  value,
}: {
  icon: LucideIcon;
  ariaLabel: string;
  value: string;
}) => (
  <div
    aria-label={ariaLabel}
    className="flex items-center gap-2"
    title={ariaLabel}
  >
    <Icon
      aria-hidden="true"
      className="text-muted-foreground size-4 shrink-0"
    />
    <span className="text-foreground truncate text-sm font-medium">
      {value}
    </span>
  </div>
);

const AuthorField = ({
  ariaLabel,
  authorUrl,
  value,
}: {
  ariaLabel: string;
  authorUrl: string | undefined;
  isFirstParty: boolean;
  value: string;
}) => {
  const safeAuthorUrl = sanitizeHref(authorUrl);
  const inner = (
    <>
      <UserIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="text-foreground truncate text-sm font-medium">
        {value}
      </span>
      {safeAuthorUrl && (
        <ExternalLinkIcon
          aria-hidden="true"
          className="text-muted-foreground size-3 shrink-0"
        />
      )}
    </>
  );

  if (safeAuthorUrl) {
    return (
      <a
        aria-label={ariaLabel}
        className="hover:bg-muted -mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors"
        href={safeAuthorUrl}
        onClick={(e) => e.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        title={ariaLabel}
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      aria-label={ariaLabel}
      className="flex items-center gap-2"
      title={ariaLabel}
    >
      {inner}
    </div>
  );
};

const ChipRow = ({
  icon: Icon,
  ariaLabel,
  values,
}: {
  icon: LucideIcon;
  ariaLabel: string;
  values: readonly string[];
}) => (
  <div
    aria-label={ariaLabel}
    className="flex items-center gap-2"
    title={ariaLabel}
  >
    <Icon
      aria-hidden="true"
      className="text-muted-foreground size-4 shrink-0"
    />
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          className="bg-muted text-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
          key={value}
        >
          {value}
        </span>
      ))}
    </div>
  </div>
);

const Divider = () => <div className="bg-border h-px w-full" />;

const kindToFilter = (kind: LoadedCatalogueEntry["kind"]) => {
  if (kind === "skill") {
    return "skills" as const;
  }
  if (kind === "mcp") {
    return "mcps" as const;
  }
  return "nativeTools" as const;
};

const setupKey = (setup: string) => {
  if (setup === "api-key") {
    return "apiKey" as const;
  }
  if (setup === "account") {
    return "account" as const;
  }
  return "none" as const;
};
