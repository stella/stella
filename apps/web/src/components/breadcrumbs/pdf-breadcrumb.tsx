import { useQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";

import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";

import { fileMetadataOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";

export const PdfBreadcrumb = () => {
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/document",
    shouldThrow: false,
  });

  const { workspaceId = "", viewId = "" } = pdfMatch?.params ?? {};
  const { entity, field, justification, justificationPage, pdfPage } =
    pdfMatch?.search ?? {};
  const fieldId = field ?? "";
  const currentSearch = {
    entity,
    field,
    justification,
    justificationPage,
    pdfPage,
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
    <BreadcrumbItem>
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ className: "text-foreground font-semibold" }}
        className="hover:text-foreground max-w-64 truncate transition-colors"
        params={{ workspaceId, viewId }}
        search={currentSearch}
        to="/workspaces/$workspaceId/$viewId/document"
      >
        {fileName ?? fieldId}
      </Link>
    </BreadcrumbItem>
  );
};
