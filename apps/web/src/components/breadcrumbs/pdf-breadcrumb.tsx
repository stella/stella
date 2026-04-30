import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";

import { fileMetadataOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";

export const PdfBreadcrumb = () => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (params) => params.workspaceId,
  });
  const viewId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (params) => params.viewId,
  });
  const fieldId = useSearch({
    select: (search) => search.field ?? "",
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
  });
  const currentSearch = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: ({ entity, field, justification, justificationPage, pdfPage }) => ({
      entity,
      field,
      justification,
      justificationPage,
      pdfPage,
    }),
  });
  const { data: fileName } = useQuery({
    ...fileMetadataOptions({ workspaceId, fieldId }),
    select: (file) => file.fileName,
  });

  return (
    <BreadcrumbItem>
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ className: "text-foreground font-semibold" }}
        className="hover:text-foreground max-w-64 truncate transition-colors"
        params={{ workspaceId, viewId }}
        search={currentSearch}
        to="/workspaces/$workspaceId/$viewId/pdf"
      >
        {fileName ?? fieldId}
      </Link>
    </BreadcrumbItem>
  );
};
