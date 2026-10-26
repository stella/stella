import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { useReaderAdapters } from "@stll/decision-reader/reader-adapters";
import { ReferencePeek } from "@stll/decision-reader/reference-peek";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import { ProvisionVersionBasisLabel } from "@/components/provision-version-basis";
import type { ProvisionGroup } from "@/features/case-law/components/case-viewer/provisions-cited.logic";
import type { ResolvedCitedStatute } from "@/features/case-law/queries/provisions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { provisionPreviewOptions } from "@/lib/statutes/provision-preview";
import { formatValidityRange } from "@/lib/statutes/statute-format";
import { createStatuteLinkTarget } from "@/lib/statutes/statute-route";

type ProvisionDocument = Pick<
  ResolvedCitedStatute,
  "country" | "eli" | "id" | "slug" | "versionValidFrom" | "versionValidTo"
>;

type ProvisionReferenceChipProps = {
  target:
    | { type: "hosted"; document: ProvisionDocument | null }
    | { type: "external"; href: string };
  label: string;
  /** What the cited anchor is cut on to find its provision's heading. */
  anchorSeparator: string | null;
  provision: ProvisionGroup;
  /** The cited work's title and jurisdiction, as the side panel names them. */
  statuteTitle: string;
  jurisdiction: string;
  versionMarker: "group" | "exception";
};

type ProvisionReferenceBodyProps = {
  document: ProvisionDocument | null;
  anchorSeparator: string | null;
  provision: ProvisionGroup;
};

/**
 * What the peek shows about the cited provision: the version it was read
 * against, its wording and the decision's sentences citing it. Mounted only
 * while the peek is open, so the wording is read only then.
 */
const ProvisionReferenceBody = ({
  document,
  anchorSeparator,
  provision,
}: ProvisionReferenceBodyProps) => {
  const t = useTranslations();
  const {
    data: wording,
    isError,
    isPending,
    refetch,
  } = useQuery({
    ...provisionPreviewOptions({
      anchor: provisionHeadingAnchor(provision.anchor, anchorSeparator),
      citedAnchor: provision.anchor,
      documentId: document?.id ?? "",
    }),
    enabled: document !== null,
  });

  return (
    <>
      <ProvisionVersionBasisLabel basis={provision.versionBasis} />
      {document !== null && isPending && <Skeleton className="h-12 w-full" />}
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
      {wording !== undefined && wording !== null && (
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
      {provision.occurrences.map(({ sentenceText, spanStart }) => (
        <BidiText as="span" className="text-xs leading-relaxed" key={spanStart}>
          {sentenceText}
        </BidiText>
      ))}
    </>
  );
};

/** A compact reference; wording is read only while its peek is open. */
export const ProvisionReferenceChip = ({
  target,
  label,
  anchorSeparator,
  provision,
  statuteTitle,
  jurisdiction,
  versionMarker,
}: ProvisionReferenceChipProps) => {
  const document = target.type === "hosted" ? target.document : null;
  const t = useTranslations();
  const format = useFormatter();
  const { openProvision } = useReaderAdapters();
  const count = provision.occurrences.length;
  const anchorId = provisionHeadingAnchor(provision.anchor, anchorSeparator);

  return (
    <ReferencePeek
      body={
        <ProvisionReferenceBody
          anchorSeparator={anchorSeparator}
          document={document}
          provision={provision}
        />
      }
      header={{
        primary: label,
        meta:
          document === null
            ? []
            : [
                {
                  part: "date",
                  text: formatValidityRange({
                    format,
                    openEnded: t("statutes.openEnded"),
                    validFrom: document.versionValidFrom,
                    validTo: document.versionValidTo,
                  }),
                },
              ],
      }}
      target={{
        kind: "provision",
        actions: {
          openInSidePanel:
            document === null
              ? null
              : () =>
                  openProvision({
                    anchorId,
                    documentId: document.id,
                    eli: document.eli,
                    highlightAnchorId: provision.anchor,
                    jurisdiction,
                    provisionLabel: label,
                    statuteTitle,
                    versionCount: 1,
                    versionValidFrom: document.versionValidFrom,
                  }),
          openInStella:
            document === null ? null : (
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
            ),
          openOriginal: target.type === "external" ? target.href : null,
        },
      }}
      trigger={{
        type: "button",
        element: (
          <Button
            className="h-auto max-w-full min-w-0 flex-wrap justify-start text-start"
            size="xs"
            variant="secondary"
          />
        ),
      }}
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
    </ReferencePeek>
  );
};
