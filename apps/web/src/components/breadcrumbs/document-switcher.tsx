import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@stll/ui/command";
import { CheckIcon, ChevronDownIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/tooltip";

import { filterDocumentsByQuery } from "@/components/breadcrumbs/document-switcher.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { ReferenceFileTypeIcon } from "@/components/references/reference-chip";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";

type DocumentSwitcherProps = {
  /** The document the main view shows, checked in the list. */
  entityId: string;
  viewId: string;
  workspaceId: string;
};

/**
 * The breadcrumb's caret beside the document name: a searchable list of the
 * matter's files, current one checked, that opens the chosen file in the main
 * view in place of this one. The list loads only once the popover opens.
 */
export const DocumentSwitcher = ({
  entityId,
  viewId,
  workspaceId,
}: DocumentSwitcherProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filesQuery = useQuery({
    ...workspaceFilesOptions(workspaceId),
    enabled: open,
  });
  const filesView = queryView(filesQuery);
  useQueryViewError(filesView, "DocumentSwitcher:query");

  const visible =
    filesView.type === "items"
      ? filterDocumentsByQuery(filesView.items, query)
      : [];
  const label = t("workspaces.documentSwitcher.trigger");

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };

  const openDocument = (file: { entityId: string; fieldId: string }) => {
    changeOpen(false);
    if (file.entityId === entityId) {
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
              {filesView.type === "items" && visible.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("common.noResults")}
                </p>
              ) : null}
              {visible.map((file) => {
                const isCurrent = file.entityId === entityId;
                return (
                  <CommandItem
                    aria-current={isCurrent ? "page" : undefined}
                    key={file.fieldId}
                    onClick={() => openDocument(file)}
                    value={file.fieldId}
                  >
                    <ReferenceFileTypeIcon mimeType={file.mimeType} />
                    <BidiText as="span" className="min-w-0 truncate">
                      {file.fileName}
                    </BidiText>
                    {isCurrent ? <CheckIcon className="ms-auto" /> : null}
                  </CommandItem>
                );
              })}
            </div>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};
