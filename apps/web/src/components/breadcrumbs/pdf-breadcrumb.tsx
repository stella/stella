import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

export const PdfBreadcrumb = () => {
  const { workspaceId } = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
  });
  const search = useSearch({
    select: (s) => ({
      fieldId: s.file.fieldId,
      entityId: s.entity.id,
    }),
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
  });
  const { data: filename } = useSuspenseQuery({
    ...entityOptions(workspaceId, search.entityId),
    select: (entity) => {
      const fileField = Object.values(entity.fields).find(
        (field) => field.id === search.fieldId,
      );

      if (fileField?.content.type !== "file") {
        return null;
      }
      return fileField.content.fileName;
    },
  });

  return (
    <BreadcrumbLink to="/workspaces/$workspaceId/$viewId/pdf">
      {filename ?? search.fieldId}
    </BreadcrumbLink>
  );
};
