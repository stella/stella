import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { ProvisionVersionBasisLabel } from "@/components/provision-version-basis";
import type { ProvisionGroup } from "@/features/case-law/components/case-viewer/provisions-cited.logic";
import type { ResolvedCitedStatute } from "@/features/case-law/queries/provisions";
import { provisionPreviewOptions } from "@/features/statutes/queries/provision-preview";
import { formatValidityRange } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { createStatuteLinkTarget } from "@/lib/statute-route";

type ProvisionDocument = Pick<
  ResolvedCitedStatute,
  "country" | "eli" | "id" | "slug" | "versionValidFrom" | "versionValidTo"
>;

type ProvisionReferenceChipProps = {
  document: ProvisionDocument | null;
  label: string;
  provision: ProvisionGroup;
  versionMarker: "group" | "exception";
};

/** A compact reference; wording is read only while its preview is open. */
export const ProvisionReferenceChip = ({
  document,
  label,
  provision,
  versionMarker,
}: ProvisionReferenceChipProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const {
    data: wording,
    isError,
    isPending,
    refetch,
  } = useQuery({
    ...provisionPreviewOptions({
      anchor: provisionHeadingAnchor(provision.anchor),
      citedAnchor: provision.anchor,
      documentId: document?.id ?? "",
    }),
    enabled: open && document !== null,
  });
  const count = provision.occurrences.length;

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        render={
          <Button
            size="xs"
            variant="secondary"
            className="h-auto max-w-full min-w-0 flex-wrap justify-start text-start"
            onClick={() => setOpen(!open)}
          />
        }
      >
        <BidiText as="span" className="text-xs">
          {label}
        </BidiText>
        {versionMarker === "exception" && (
          <Tooltip>
            <TooltipTrigger render={<span data-version-basis="exception" />}>
              <ProvisionVersionBasisLabel
                basis={provision.versionBasis}
                compact
              />
            </TooltipTrigger>
            <TooltipPopup>
              <ProvisionVersionBasisLabel basis={provision.versionBasis} />
            </TooltipPopup>
          </Tooltip>
        )}
        {count > 1 && (
          <span
            className="text-muted-foreground text-2xs tabular-nums"
            aria-label={t("caseLaw.viewer.provisionMentionsLabel", { count })}
          >
            {t("caseLaw.viewer.provisionMentions", { count })}
          </span>
        )}
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex min-w-0 flex-col gap-2">
          <BidiText as="span" className="text-sm font-medium">
            {label}
          </BidiText>
          <ProvisionVersionBasisLabel basis={provision.versionBasis} />
          {document !== null && (
            <BidiText as="span" className="text-muted-foreground text-2xs">
              {formatValidityRange({
                format,
                openEnded: t("statutes.openEnded"),
                validFrom: document.versionValidFrom,
                validTo: document.versionValidTo,
              })}
            </BidiText>
          )}
          {document !== null && isPending && !isError && (
            <Skeleton className="h-12 w-full" />
          )}
          {isError && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {t("errors.actionFailed")}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  detached(refetch(), "case-law.provision-preview-retry")
                }
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {wording !== undefined && (
            <BidiText
              as="span"
              className="line-clamp-6 text-xs leading-relaxed"
              lang={wording.language}
            >
              {wording.blocks.map(({ text }) => text).join("\n\n")}
            </BidiText>
          )}
          <span className="text-muted-foreground text-2xs">
            {t("caseLaw.viewer.citedDecisionPassage")}
          </span>
          <ScrollArea axis="vertical" className="max-h-40" scrollFade>
            <div className="flex flex-col gap-2">
              {provision.occurrences.map(({ sentenceText, spanStart }) => (
                <BidiText
                  as="span"
                  className="text-xs leading-relaxed"
                  key={spanStart}
                >
                  {sentenceText}
                </BidiText>
              ))}
            </div>
          </ScrollArea>
          {document !== null && (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              render={
                <Link
                  hash={provision.anchor}
                  {...createStatuteLinkTarget({
                    country: document.country,
                    documentId: document.id,
                    eli: document.eli,
                    slug: document.slug,
                    versionValidFrom: document.versionValidFrom,
                  })}
                />
              }
            >
              {t("statutes.openProvision")}
            </Button>
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
};
