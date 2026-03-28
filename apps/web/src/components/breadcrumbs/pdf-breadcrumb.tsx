import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";

export const PdfBreadcrumb = () => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (params) => params.workspaceId,
  });
  const fieldId = useSearch({
    select: (search) => search.file.fieldId,
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
  });
  const { data: fileName } = useQuery({
    ...fileOptions({ workspaceId, fieldId }),
    select: (file) => file.fileName,
  });

  return (
    <BreadcrumbLink to="/workspaces/$workspaceId/$viewId/pdf">
      {fileName ?? fieldId}
    </BreadcrumbLink>
  );
};
