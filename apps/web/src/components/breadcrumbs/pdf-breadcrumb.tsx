import { useQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";

import { fileMetadataOptions } from "@/lib/files/file-metadata-query";

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
  const currentSearch = {
    entity,
    field,
    justification,
    justificationPage,
    pdfPage,
    pdfMode: undefined,
  };
  const { data: fileName } = useQuery({
    ...fileMetadataOptions({ workspaceId, fieldId }),
    enabled: pdfMatch !== undefined && fieldId.length > 0,
    select: (file) => file.fileName,
  });

  if (!pdfMatch) {
    return null;
  }

  return (
    <>
      <BreadcrumbItem>
        <Link
          activeOptions={{
            exact: true,
            includeSearch: true,
            explicitUndefined: true,
          }}
          activeProps={{ className: "text-foreground font-semibold" }}
          className="hover:text-foreground max-w-64 truncate transition-colors"
          params={{ workspaceId, viewId }}
          search={currentSearch}
          to="/workspaces/$workspaceId/$viewId/document"
        >
          <BidiText>{fileName ?? fieldId}</BidiText>
        </Link>
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
