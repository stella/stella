import { useTranslations } from "use-intl";

import { openFilePicker } from "@stll/ui/file-picker";
import { UploadIcon } from "@stll/ui/icons";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";

import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { useCreateFileEntities } from "@/lib/workspaces/mutations/use-create-file-entities";

/**
 * The matter's upload action, published into the app header so it is one
 * click away from every matter tab (overview, table, files, correspondence).
 */
export const MatterUploadAction = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations("workspaces");
  const [, createFileEntities] = useCreateFileEntities(workspaceId);
  const label = t("uploadDocuments");

  return (
    <ChromeHeaderActions>
      <ToolbarIconAction
        density="header"
        icon={<UploadIcon className="size-4" />}
        label={label}
        onClick={() => {
          openFilePicker({
            multiple: true,
            onPick: (files) => {
              createFileEntities({ files, parentId: null });
            },
          });
        }}
      />
    </ChromeHeaderActions>
  );
};
