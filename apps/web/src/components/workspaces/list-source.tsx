/**
 * Where a list item's source points: its document and, in a PDF, the page.
 * Shared by the list's source panel and the anchor facts of a verification.
 */

import type { ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { stellaToast } from "@stll/ui/toast";

import { openSourceFile } from "@/components/workspaces/list-source.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import type { LegalListSourceLocator } from "@/lib/api-contract";
import { detached } from "@/lib/detached";
import { entityOptions } from "@/lib/workspaces/queries/entities";

type SourceLocatorLabelProps = {
  locator: LegalListSourceLocator;
  /** Null when the caller does not know it; the label then says "Document". */
  documentName?: string | null;
};

// Annotated, not inferred: React 19's `ReactNode` admits a promise, so
// `t.rich`'s inferred return reads as a maybe-async function.
export const SourceLocatorLabel = ({
  locator,
  documentName = null,
}: SourceLocatorLabelProps): ReactNode => {
  const t = useTranslations();
  const format = useFormatter();
  const name = documentName ?? t("common.document");
  switch (locator.type) {
    case "pdf-page": {
      return t.rich("common.documentPage", {
        bdi: (chunks) => <BidiText>{chunks}</BidiText>,
        document: name,
        page: format.number(locator.pageNumber),
      });
    }
    case "docx-block": {
      return <BidiText>{documentName ?? locator.blockId}</BidiText>;
    }
    case "document": {
      return <BidiText>{name}</BidiText>;
    }
    default: {
      locator satisfies never;
      return panic("Unhandled source locator");
    }
  }
};

/** The page a locator opens its document at, if it names one. */
export const sourceLocatorPage = (
  locator: LegalListSourceLocator,
): number | undefined =>
  locator.type === "pdf-page" ? locator.pageNumber : undefined;

/** Opens a source's document in the matter's viewer, at the page it cites. */
export const useOpenSourceDocument = (workspaceId: string) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (entityId: string, pdfPage?: number) => {
    detached(
      (async () => {
        const result = await openSourceFile({
          load: async () =>
            await queryClient.query(entityOptions(workspaceId, entityId)),
          navigate: async (fieldId) => {
            await navigate({
              to: "/workspaces/$workspaceId/$viewId/document",
              params: { workspaceId, viewId: "all" },
              search: {
                entity: entityId,
                field: fieldId,
                ...(pdfPage === undefined ? {} : { pdfPage }),
              },
            });
          },
        });
        if (Result.isError(result)) {
          getAnalytics().captureError(result.error);
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        }
      })(),
      "list-source.open-document",
    );
  };
};
