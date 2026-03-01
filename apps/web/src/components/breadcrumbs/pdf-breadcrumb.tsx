import { useSearch } from "@tanstack/react-router";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

export const PdfBreadcrumb = () => {
  const search = useSearch({
    select: (s) => ({
      fieldId: s.file.fieldId,
      entityId: s.entity.id,
    }),
    from: "/_protected/workspaces/$workspaceId/pdf",
  });
  const filename: string =
    useWorkspaceStore((s) => {
      const entity = s.data.find((e) => e.entityId === search.entityId);
      if (!entity) {
        return null;
      }
      const fileField = Object.values(entity.fields).find(
        (field) => field.id === search.fieldId,
      );

      if (fileField?.content.type !== "file") {
        return null;
      }
      return fileField.content.fileName;
    }) ?? search.fieldId;

  return (
    <BreadcrumbLink to="/workspaces/$workspaceId/pdf">
      {filename}
    </BreadcrumbLink>
  );
};
