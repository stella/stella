import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { similarDocumentsOptions } from "@/lib/workspaces/queries/similar-documents";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

type SimilarDocumentsSectionProps = {
  workspaceId: string;
  entityId: string;
  heading: (title: string) => React.ReactNode;
  openDocument?: typeof openEntityInInspector;
};

/**
 * Documents in the matter whose text is nearly the same as this one's. Shows
 * nothing while loading or when there is none, so an ordinary document gains
 * no empty section.
 */
export const SimilarDocumentsSection = ({
  workspaceId,
  entityId,
  heading,
  openDocument = openEntityInInspector,
}: SimilarDocumentsSectionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const view = queryView(
    useQuery(similarDocumentsOptions(workspaceId, entityId)),
  );
  if (view.type === "pending" || view.type === "empty") {
    return null;
  }

  return (
    <>
      {heading(t("inspector.metadata.similarDocuments.heading"))}
      {(view.type === "error" || view.refetchError !== undefined) && (
        <div className="px-4 py-2">
          <QueryViewFeedback view={view} />
        </div>
      )}
      {view.type === "items" && view.items.length > 0 && (
        <ul className="flex flex-col gap-px px-2 pb-2">
          {view.items.map((document) => (
            <li key={document.entityId}>
              <Button
                onClick={() =>
                  detached(
                    openDocument({
                      documentOnScreen: getCurrentWorkspaceDocument(
                        router.state.matches,
                      ),
                      entityId: document.entityId,
                      label: document.entityName,
                      workspaceId,
                    }),
                    "similar-documents.open",
                  )
                }
                size="row"
                variant="ghost"
              >
                <TruncatedText
                  className="min-w-0 flex-1 text-start"
                  render={<BidiText as="span" />}
                >
                  {document.entityName}
                </TruncatedText>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {t("inspector.metadata.similarDocuments.similarity", {
                    percent: format.number(document.similarity, {
                      style: "percent",
                    }),
                  })}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};
