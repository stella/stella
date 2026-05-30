import { useMemo } from "react";

import { useTranslations } from "use-intl";

import {
  pinnedCatalogueEntries,
  type LoadedCatalogueEntry,
} from "@stll/catalogue";

import { StellaWordmark } from "@/components/stella-wordmark";
import { CatalogueEntryIcon } from "@/routes/_protected.settings/-components/catalogue/catalogue-entry-icon";

/**
 * Right-panel "agent profile" for the onboarding catalogue step. A
 * single glass-surface card that mirrors the assistant the user is
 * configuring: built-in baseline at the top, picked stack underneath,
 * a tabular-num counter at the foot. Items reveal with opacity-only
 * transitions and a 30 ms stagger so adding a capability feels like
 * filling in a list, not throwing cards on a pile. Clicking a row
 * expands its description in place — single-selection so the card
 * stays one viewport.
 *
 * Visual language: glass-like translucent surface, monochrome, one
 * subtle ring instead of competing borders. No layout-animated
 * properties — only opacity + transform.
 */
type CatalogueStackPreviewProps = {
  entries: readonly LoadedCatalogueEntry[];
  selectedSlugs: readonly string[];
  /**
   * Optional. When provided, clicking a row in the stack preview
   * focuses that entry on the left and surfaces the full detail card
   * on the right (replacing this preview). Without it, rows are
   * non-interactive.
   */
  onFocus?: (slug: string) => void;
};

const STAGGER_MS = 35;
const STAGGER_CAP = 8;

const ANIMATION_STYLE = `
@keyframes catalogue-row-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.catalogue-row-in {
  animation: catalogue-row-in 220ms ease-out both;
}
`;

export const CatalogueStackPreview = ({
  entries,
  selectedSlugs,
  onFocus,
}: CatalogueStackPreviewProps) => {
  const t = useTranslations();

  const pinned = useMemo(() => pinnedCatalogueEntries(), []);
  const pinnedSlugSet = useMemo(
    () => new Set(pinned.map((entry) => entry.slug)),
    [pinned],
  );

  const stack = useMemo(() => {
    const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
    return selectedSlugs
      .filter((slug) => !pinnedSlugSet.has(slug))
      .map((slug) => bySlug.get(slug))
      .filter((entry): entry is LoadedCatalogueEntry => entry !== undefined);
  }, [entries, selectedSlugs, pinnedSlugSet]);

  const total = pinned.length + stack.length;

  // Clicking a stack-preview row opens the full Privacy Nutritional
  // Label detail card for that entry (delegated to the wizard via
  // onFocus). If no callback is wired, rows do nothing.
  const handleRowClick = (slug: string) => {
    if (onFocus) {
      onFocus(slug);
    }
  };

  return (
    <div className="flex h-full max-h-full w-full items-stretch justify-center overflow-hidden">
      <style>{ANIMATION_STYLE}</style>

      <div className="bg-background border-border/40 flex h-full max-h-full w-full max-w-[340px] flex-col rounded-2xl border shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)]">
        <header className="border-border flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <StellaWordmark className="h-4" />
            <span className="border-border text-muted-foreground rounded-sm border px-1.5 py-0.5 text-[0.625rem] font-medium tracking-[0.1em] uppercase">
              AI
            </span>
          </div>
          <span
            className="text-muted-foreground text-[10px] tracking-wider uppercase"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {t("onboarding.cataloguePreviewCount", { count: total })}
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          <Section title={t("onboarding.cataloguePreviewBaseline")}>
            {pinned.map((entry, index) => (
              <Row
                entry={entry}
                index={index}
                key={entry.slug}
                tone="baseline"
              />
            ))}
          </Section>

          <div className="bg-border h-px w-full" />

          <Section title={t("onboarding.cataloguePreviewYourStack")}>
            {stack.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">
                {t("onboarding.cataloguePreviewEmpty")}
              </p>
            ) : (
              stack.map((entry, index) => (
                <Row
                  entry={entry}
                  index={index}
                  key={entry.slug}
                  onClick={() => handleRowClick(entry.slug)}
                  tone="stack"
                />
              ))
            )}
          </Section>
        </div>
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
  <section className="flex flex-col gap-2">
    <h3 className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
      {title}
    </h3>
    <div className="flex flex-col gap-1.5">{children}</div>
  </section>
);

const Row = ({
  entry,
  index,
  tone,
  onClick,
}: {
  entry: LoadedCatalogueEntry;
  index: number;
  tone: "baseline" | "stack";
  /** Baseline rows are always-on and read-only — omit onClick there. */
  onClick?: () => void;
}) => {
  const t = useTranslations();
  const delay = Math.min(index, STAGGER_CAP) * STAGGER_MS;

  const content = (
    <>
      <CatalogueEntryIcon
        className={
          tone === "baseline" ? "text-foreground" : "text-muted-foreground"
        }
        icon={entry.icon}
        iconUrl={entry.iconUrl ?? null}
        size={20}
        slug={entry.slug}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-sm">
          {entry.displayName}
        </span>
        {entry.jurisdictions.length > 0 && (
          <span className="text-muted-foreground text-[10px]">
            {entry.jurisdictions.join(" · ")}
          </span>
        )}
      </div>
      {tone === "baseline" && (
        <span className="text-foreground-placeholder text-[10px] tracking-wider uppercase">
          {t("onboarding.catalogueAlwaysOn")}
        </span>
      )}
    </>
  );

  if (!onClick) {
    return (
      <div
        className="catalogue-row-in -mx-1 flex items-center gap-2.5 rounded-md px-1 py-1 text-start"
        style={{ animationDelay: `${delay}ms` }}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      className="catalogue-row-in hover:bg-muted/40 -mx-1 flex items-center gap-2.5 rounded-md px-1 py-1 text-start transition-colors"
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      type="button"
    >
      {content}
    </button>
  );
};
