import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { RouteDocumentTitle } from "@/components/route-document-title";
import { guidanceDocumentOptions } from "@/lib/guidance/queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/guidance/$documentId")({
  staticData: { presentation: routePresentation({ type: "none" }) },
  component: GuidanceReaderPage,
  loader: async ({ context, params }) =>
    await ensureRouteQueryData(
      context.queryClient,
      guidanceDocumentOptions(params.documentId),
    ),
});

const paragraphsOf = (text: string) =>
  text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

function GuidanceReaderPage() {
  const t = useTranslations();
  const documentId = Route.useParams({
    select: (params) => params.documentId,
  });
  const { data: guidance } = useSuspenseQuery(
    guidanceDocumentOptions(documentId),
  );
  const publisherUrl = guidance.publisherUrl;
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
      <RouteDocumentTitle routeId={Route.id} title={guidance.title} />
      <p className="text-muted-foreground text-sm">
        {t("guidance.notCaseLaw")}
      </p>
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          {[guidance.issuer.name, guidance.sourceKind ?? guidance.kind]
            .filter((part) => part !== "")
            .join(" · ")}
        </p>
        <h1 className="text-xl font-semibold text-balance">{guidance.title}</h1>
        {guidance.reference !== null && (
          <p className="text-muted-foreground text-sm">{guidance.reference}</p>
        )}
        {guidance.issuedOn !== null && (
          <p className="text-muted-foreground text-sm">
            <time dateTime={guidance.issuedOn}>{guidance.issuedOn}</time>
          </p>
        )}
      </header>
      {guidance.text === null ? (
        <p className="text-muted-foreground text-sm">
          {t("guidance.textUnavailable")}
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm leading-relaxed">
          {paragraphsOf(guidance.text).map((paragraph, index) => (
            // Paragraphs of one immutable version never reorder.
            // oxlint-disable-next-line react/no-array-index-key -- the list is static for this document version
            <p key={index} className="whitespace-pre-line">
              {paragraph}
            </p>
          ))}
        </div>
      )}
      <footer className="text-muted-foreground flex flex-col gap-1 border-t pt-4 text-xs">
        <p>
          {t("guidance.source", { attribution: guidance.attribution.text })}
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
      </footer>
    </article>
  );
}
