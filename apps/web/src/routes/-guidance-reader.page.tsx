import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { guidanceDocumentOptions } from "@/lib/legal/guidance-queries";

import { GuidanceReaderShell } from "./-guidance-reader.pending";

const routeApi = getRouteApi("/_protected/guidance/$guidanceId");

/** The text's blank-line separated paragraphs, each with where it starts. */
const paragraphsOf = (text: string) => {
  const paragraphs: { offset: number; text: string }[] = [];
  for (const match of text.matchAll(/(?:[^\n]|\n(?!\n))+/gu)) {
    const paragraph = match[0].trim();
    if (paragraph !== "") {
      paragraphs.push({ offset: match.index, text: paragraph });
    }
  }
  return paragraphs;
};

export function GuidanceReaderPage() {
  const t = useTranslations();
  const guidanceId = routeApi.useParams({
    select: (params) => params.guidanceId,
  });
  const { data: guidance } = useSuspenseQuery(
    guidanceDocumentOptions(guidanceId),
  );
  const publisherUrl = guidance.publisherUrl;
  return (
    <GuidanceReaderShell
      header={
        <>
          <p className="text-muted-foreground text-sm">
            {[guidance.issuer.name, guidance.sourceKind ?? guidance.kind]
              .filter((part) => part !== "")
              .join(" · ")}
          </p>
          <h1 className="text-xl font-semibold text-balance">
            {guidance.title}
          </h1>
          {guidance.reference !== null && (
            <p className="text-muted-foreground text-sm">
              {guidance.reference}
            </p>
          )}
          {guidance.issuedOn !== null && (
            <p className="text-muted-foreground text-sm">
              <time dateTime={guidance.issuedOn}>{guidance.issuedOn}</time>
            </p>
          )}
        </>
      }
      body={
        guidance.text === null ? (
          <p className="text-muted-foreground text-sm">
            {t("guidance.textUnavailable")}
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-sm leading-relaxed">
            {paragraphsOf(guidance.text).map((paragraph) => (
              <p key={paragraph.offset} className="whitespace-pre-line">
                {paragraph.text}
              </p>
            ))}
          </div>
        )
      }
      footer={
        <>
          <p>
            {t("guidance.source", {
              attribution: guidance.attribution.text,
            })}
          </p>
          {guidance.attribution.conditions.map((condition) => (
            <p key={condition}>{condition}</p>
          ))}
          {publisherUrl !== null && (
            <a
              className="underline"
              href={sanitizeHref(publisherUrl)}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("guidance.openAtPublisher")}
            </a>
          )}
        </>
      }
    />
  );
}
