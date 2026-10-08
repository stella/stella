import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { PanelRightIcon } from "@stll/ui/icons";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import { statuteActLabel } from "@/features/statutes/statute-act-number";
import { formatValidityDate } from "@/features/statutes/statute-format";

const HeaderSeparator = () => (
  <span aria-hidden="true" className="text-muted-foreground shrink-0 text-xs">
    ·
  </span>
);

type ProvisionCardHeaderProps = {
  /** What the card is about, e.g. `§ 226 odst. 1`; never shortened. */
  label: string;
  provision: ProvisionViewPayload;
};

/**
 * The one header every cited-provision card draws, inline under a paragraph
 * and in the citation's hover card: one row naming the provision, the act
 * by number and title, the date the quoted wording took effect, and a
 * button that opens the provision.
 *
 * The row never wraps, and the open button sits outside the part that gives
 * way, so it is always there to press. When the rest runs out of room it
 * gives way in a fixed order: the act's title first (it takes only the room
 * left once the label and the date fit), then the provision label (its full
 * text stays in the tooltip), and the date last, cut off at the edge.
 */
export const ProvisionCardHeader = ({
  label,
  provision,
}: ProvisionCardHeaderProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const inspector = useInspectorView();
  const act = statuteActLabel({
    eli: provision.eli,
    title: provision.statuteTitle,
  });
  const actText = [act.number, act.name]
    .filter((part) => part !== null)
    .join(", ");
  const date = formatValidityDate(provision.versionValidFrom, format);

  return (
    <span
      className="reader-chrome flex min-w-0 items-center gap-1.5"
      data-slot="provision-card-header"
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap"
        data-slot="provision-card-summary"
      >
        <BidiText
          as="span"
          className="min-w-0 truncate text-sm font-medium"
          data-slot="provision-card-label"
          title={label}
        >
          {label}
        </BidiText>
        {actText !== "" && (
          <>
            <HeaderSeparator />
            <BidiText
              as="span"
              className="text-muted-foreground max-w-max min-w-0 flex-1 basis-0 truncate text-xs"
              data-slot="provision-card-act"
              title={actText}
            >
              {actText}
            </BidiText>
          </>
        )}
        <HeaderSeparator />
        <span
          className="text-muted-foreground shrink-0 text-xs"
          data-slot="provision-card-date"
        >
          {date === null
            ? t("statutes.wordingVersionUnknown")
            : t("statutes.provisionEffectiveFrom", { date })}
        </span>
      </span>
      <Button
        aria-label={t("statutes.openProvision")}
        className="shrink-0"
        onClick={() => inspector.open(createProvisionViewTab(provision))}
        size="icon-xs"
        tooltip={t("statutes.openProvision")}
        variant="ghost"
      >
        <PanelRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </span>
  );
};

/**
 * Hides a one-line row whose text does not fit on its line, rather than
 * wrapping it or cutting it off mid-word, and shows it again once the line
 * is wide enough. A callback ref, so the observer lives exactly as long as
 * the row.
 */
const hideWhenClipped = (line: HTMLElement | null) => {
  if (line === null) {
    return undefined;
  }
  const fit = () => {
    line.toggleAttribute("data-clipped", line.scrollWidth > line.clientWidth);
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(line);
  return () => {
    observer.disconnect();
  };
};

/**
 * Where the provision sits (part › chapter › …), on one muted line when it
 * fits there and not at all otherwise: a reader placing a provision needs
 * the whole trail or none of it.
 */
export const ProvisionTrailLine = ({
  language,
  trail,
}: {
  language: string | undefined;
  trail: readonly string[];
}) =>
  trail.length === 0 ? null : (
    <span
      className="reader-chrome text-muted-foreground block overflow-hidden text-xs whitespace-nowrap data-clipped:invisible data-clipped:h-0"
      data-slot="provision-card-trail"
      lang={language}
      ref={hideWhenClipped}
    >
      <BidiText as="span">{trail.join(" › ")}</BidiText>
    </span>
  );
