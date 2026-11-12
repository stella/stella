import { useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@stll/ui/command";
import { CheckIcon, ChevronDownIcon, DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { TruncatedText } from "@stll/ui/truncated-text";

import { isCurrentDocument } from "@/components/breadcrumbs/document-switcher.logic";
import { DocumentIcon } from "@/components/document-icon";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import {
  getEntityFileDownloadRenditions,
  getPrimaryDownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  entityOptions,
  workspaceFileSearchOptions,
} from "@/lib/workspaces/queries/entities";

const DOCUMENT_SEARCH_DEBOUNCE_MS = 200;

type DocumentSwitcherProps = {
  /** The document the main view shows, checked in the list. */
  entityId: string;
  fieldId: string;
  /** The open document's name, which its download is saved under. */
  fileName: string;
  viewId: string;
  workspaceId: string;
};

/**
 * The breadcrumb's caret beside the document name: a searchable list of the
 * matter's files, current one checked, that opens the chosen file in the main
 * view in place of this one. The list loads only once the popover opens, one
 * server-filtered page at a time. A footer pinned below the list downloads the
 * open document, the same copy the document toolbar's Download hands over.
 */
export const DocumentSwitcher = ({
  entityId,
  fieldId,
  fileName,
  viewId,
  workspaceId,
}: DocumentSwitcherProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search] = useDebounce(query, DOCUMENT_SEARCH_DEBOUNCE_MS);
  const filesQuery = useInfiniteQuery({
    ...workspaceFileSearchOptions({ workspaceId, search }),
    enabled: open,
    // Keeps the last matches on screen while the next term loads.
    placeholderData: keepPreviousData,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
  const filesView = queryView(filesQuery);
  useQueryViewError(filesView, "DocumentSwitcher:query");
  // The document route has already read this entity; the footer reuses it to
  // pick the same download copy as the toolbar.
  const renditionsQuery = useQuery({
    ...entityOptions(workspaceId, entityId),
    enabled: open,
    select: (entity) =>
      getEntityFileDownloadRenditions({ entityData: entity, fieldId }),
  });
  const renditionsView = queryView(renditionsQuery);
  useQueryViewError(renditionsView, "DocumentSwitcher:renditions");

  const visible = filesView.type === "items" ? filesView.items : [];
  const label = t("workspaces.documentSwitcher.trigger");

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };

  const downloadCurrent = () => {
    if (renditionsView.type !== "items") {
      return;
    }
    changeOpen(false);
    detached(
      downloadTabFile({
        fieldId,
        fileName,
        variant: getPrimaryDownloadVariant(renditionsView.items),
        workspaceId,
        onError: (message, error) => {
          notifyUserError(error, message);
        },
      }),
      "document-switcher.download",
    );
  };

  const openDocument = (file: { entityId: string; fieldId: string }) => {
    changeOpen(false);
    if (isCurrentDocument(file, { entityId, fieldId })) {
      return;
    }
    detached(
      navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId },
        search: { entity: file.entityId, field: file.fieldId },
      }),
      "document-switcher.navigate",
    );
  };

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <TooltipRoot>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button aria-label={label} size="icon-xs" variant="ghost" />
              }
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </TooltipRoot>
      <PopoverPopup align="start" className="w-80" padding="none">
        <Command mode="none" onValueChange={setQuery} value={query}>
          <div className="border-b px-2.5 py-2">
            <CommandInput
              aria-label={label}
              autoFocus
              placeholder={t("workspaces.documentSwitcher.searchPlaceholder")}
              size="sm"
            />
          </div>
          <CommandList>
            <div className="p-1">
              {filesView.type !== "items" ||
              filesView.refetchError !== undefined ? (
                <div className="px-2 py-1.5">
                  <QueryViewFeedback view={filesView} />
                </div>
              ) : null}
              {filesView.type === "empty" ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("common.noResults")}
                </p>
              ) : null}
              {visible.map((file) => {
                const isCurrent = isCurrentDocument(file, {
                  entityId,
                  fieldId,
                });
                return (
                  <CommandItem
                    aria-current={isCurrent ? "page" : undefined}
                    key={file.fieldId}
                    onClick={() => openDocument(file)}
                    value={file.fieldId}
                  >
                    <DocumentIcon
                      fileName={file.fileName}
                      mimeType={file.mimeType}
                    />
                    <TruncatedText render={<BidiText as="span" />}>
                      {file.fileName}
                    </TruncatedText>
                    {isCurrent ? <CheckIcon className="ms-auto" /> : null}
                  </CommandItem>
                );
              })}
              {filesView.type === "items" && filesQuery.hasNextPage ? (
                <Button
                  className="w-full"
                  disabled={filesQuery.isFetchingNextPage}
                  onClick={() =>
                    detached(
                      filesQuery.fetchNextPage(),
                      "document-switcher.fetch-next-page",
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  {filesQuery.isFetchingNextPage ? (
                    <Loader size="sm" variant="decorative" />
                  ) : null}
                  {filesQuery.isFetchingNextPage
                    ? t("common.loading")
                    : t("common.loadMore")}
                </Button>
              ) : null}
            </div>
          </CommandList>
          <div className="border-t p-1">
            <Button
              disabled={renditionsView.type !== "items"}
              onClick={downloadCurrent}
              size="row"
              variant="ghost"
            >
              <DownloadIcon />
              {t("workspaces.documentSwitcher.download")}
            </Button>
          </div>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};
