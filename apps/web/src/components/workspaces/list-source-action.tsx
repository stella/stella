import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import {
  ListSourceForm,
  type ListSourceFormProps,
} from "@/components/workspaces/list-source-form";
import { usePermissions } from "@/hooks/use-permissions";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";

type ListSourceActionProps = Omit<ListSourceFormProps, "onClose">;

export const ListSourceAction = (props: ListSourceActionProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  const canUpdate = usePermissions({ entity: ["update"] });
  if (!enabled || !canUpdate) {
    return null;
  }
  if (!open) {
    return (
      <Button
        className="min-h-11"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
      >
        {t("lists.sources.add")}
      </Button>
    );
  }
  return (
    <ListSourceForm
      key={`${props.workspaceId}:${props.listId}:${props.itemEntityId}`}
      {...props}
      onClose={() => setOpen(false)}
    />
  );
};
