import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { similarDocumentsOptions } from "@/lib/workspaces/queries/similar-documents";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

type SimilarDocumentsListProps = {
  workspaceId: string;
  entityId: string;
  openDocument: typeof openEntityInInspector;
};

const SimilarDocumentsList = ({
  workspaceId,
  entityId,
  openDocument,
}: SimilarDocumentsListProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const view = queryView(
    useQuery(similarDocumentsOptions(workspaceId, entityId)),
  );
  if (view.type === "empty") {
    return (
      <p className="text-muted-foreground px-4 py-2 text-sm">
        {t("common.noResults")}
      </p>
    );
  }
  if (view.type !== "items") {
    return (
      <div className="px-4 py-2">
        <QueryViewFeedback view={view} />
      </div>
    );
  }

  return (
    <>
      {view.refetchError !== undefined && (
        <div className="px-4 py-2">
          <QueryViewFeedback view={view} />
        </div>
      )}
      {view.items.length > 0 && (
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

type SimilarDocumentsSectionProps = {
  workspaceId: string;
  entityId: string;
  heading: (title: React.ReactNode) => React.ReactNode;
  openDocument?: typeof openEntityInInspector;
};

/**
 * Documents in the matter whose text is nearly the same as this one's.
 * Collapsed by default: the list is read only once the reader expands it, so
 * opening a document makes no request for it.
 */
export const SimilarDocumentsSection = ({
  workspaceId,
  entityId,
  heading,
  openDocument = openEntityInInspector,
}: SimilarDocumentsSectionProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      {heading(
        <CollapsibleTrigger
          render={<Button className="flex w-full" variant="plain" />}
        >
          <span className="flex w-full items-center gap-1.5 text-start">
            <DirectionalIcon
              className={cn(
                "size-3 shrink-0 transition-transform",
                isOpen && "rotate-90",
              )}
              flip={!isOpen}
              icon={ChevronRightIcon}
            />
            {t("inspector.metadata.similarDocuments.heading")}
          </span>
        </CollapsibleTrigger>,
      )}
      <CollapsiblePanel>
        {isOpen && (
          <SimilarDocumentsList
            entityId={entityId}
            openDocument={openDocument}
            workspaceId={workspaceId}
          />
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
};
