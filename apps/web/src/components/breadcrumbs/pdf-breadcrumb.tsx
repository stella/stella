import { useQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";

import {
  canRenameDocumentCrumb,
  resolveCrumbRenameShortcut,
  resolveDocumentRenameSubmission,
  splitFileName,
} from "@/components/breadcrumbs/pdf-breadcrumb.logic";
import { BreadcrumbQueryContent } from "@/components/breadcrumbs/query-content";
import { InlineEdit } from "@/components/inline-edit";
import Tooltip from "@/components/tooltip";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { fileMetadataOptions } from "@/lib/files/file-metadata-query";
import { useQueryView } from "@/lib/use-query-view";
import { useRenameEntity } from "@/lib/workspaces/mutations/entities";

export const PdfBreadcrumb = () => {
  const tCommon = useTranslations("common");
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/document",
    shouldThrow: false,
  });

  const { workspaceId = "", viewId = "" } = pdfMatch?.params ?? {};
  const { entity, field, justification, justificationPage, pdfPage, pdfMode } =
    pdfMatch?.search ?? {};
  const fieldId = field ?? "";
  const entityId = entity ?? "";
  const currentSearch = {
    entity,
    field,
    justification,
    justificationPage,
    pdfPage,
    pdfMode: undefined,
  };
  const fileMetadata = fileMetadataOptions({ workspaceId, fieldId });
  const fileQuery = useQuery({
    ...fileMetadata,
    enabled: pdfMatch !== undefined && fieldId.length > 0,
    select: (file) => file.fileName,
  });
  const fileNameView = useQueryView(fileQuery);
  const fileName =
    fileNameView.type === "items" ? fileNameView.items : undefined;
  const canUpdateEntity = usePermissions({ entity: ["update"] });
  const renameEntity = useRenameEntity();

  const storedName = fileName ?? fieldId;
  const { baseName, extension } = splitFileName(storedName);

  const rename = useInlineRename({
    initial: baseName,
    onCommit: (value) => {
      const submission = resolveDocumentRenameSubmission({
        draft: value,
        currentName: storedName,
      });
      if (submission.type === "discard") {
        return;
      }
      renameEntity.mutate({ workspaceId, entityId, name: submission.name });
    },
  });

  if (!pdfMatch) {
    return null;
  }

  if (fileNameView.type !== "items") {
    return <BreadcrumbQueryContent view={fileNameView} />;
  }

  // While the rename is in flight the crumb shows the submitted name and
  // offers no editor, so a second rename cannot race the first.
  const pendingName = renameEntity.isPending
    ? renameEntity.variables.name
    : null;

  // Until the metadata lands there is no stored name to edit, only the
  // `fieldId` the crumb falls back to; a commit then would rename the document
  // to that id.
  const isRenameable =
    fileName !== undefined &&
    canRenameDocumentCrumb({
      entityId,
      canUpdateEntity,
      isLastCrumb: pdfMode !== "organize",
    });

  return (
    <>
      <BreadcrumbQueryContent view={fileNameView} />
      <BreadcrumbItem>
        {(() => {
          if (rename.state.mode === "edit") {
            return (
              <InlineEdit
                inputAriaLabel={tCommon("documentName")}
                onCancel={rename.cancel}
                onChange={rename.setDraft}
                onCommit={() => {
                  detached(rename.commit(), "pdf-breadcrumb.commit");
                }}
                suffix={
                  extension ? (
                    <span className="text-muted-foreground text-xs">
                      {extension}
                    </span>
                  ) : undefined
                }
                value={rename.state.draft}
              />
            );
          }

          if (pendingName !== null) {
            return (
              <BreadcrumbPage>
                <BidiText
                  as="span"
                  className="max-w-64 overflow-hidden text-ellipsis whitespace-pre"
                >
                  {pendingName}
                </BidiText>
              </BreadcrumbPage>
            );
          }

          const crumbLink = (
            <Link
              activeOptions={{
                exact: true,
                includeSearch: true,
                explicitUndefined: true,
              }}
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground max-w-64 overflow-hidden text-ellipsis whitespace-pre"
              params={{ workspaceId, viewId }}
              onDoubleClick={(event) => {
                if (!isRenameable) {
                  return;
                }
                // Keeps the second click from selecting the crumb text; the
                // first click's navigation to this same route already ran.
                event.preventDefault();
                rename.startEditing(baseName);
              }}
              onKeyDown={(event) => {
                if (
                  !isRenameable ||
                  resolveCrumbRenameShortcut(event.key) === "ignore"
                ) {
                  return;
                }
                event.preventDefault();
                rename.startEditing(baseName);
              }}
              search={currentSearch}
              to="/workspaces/$workspaceId/$viewId/document"
              {...(isRenameable ? { "aria-keyshortcuts": "F2" } : {})}
            >
              <BidiText>{storedName}</BidiText>
            </Link>
          );

          if (!isRenameable) {
            return crumbLink;
          }

          return (
            <Tooltip
              content={tCommon("doubleClickToRename")}
              render={crumbLink}
            />
          );
        })()}
      </BreadcrumbItem>
      {pdfMode === "organize" && (
        <>
          <BreadcrumbSeparator className="shrink-0" />
          <BreadcrumbItem className="shrink-0">
            <BreadcrumbPage>{tCommon("editing")}</BreadcrumbPage>
          </BreadcrumbItem>
        </>
      )}
    </>
  );
};
