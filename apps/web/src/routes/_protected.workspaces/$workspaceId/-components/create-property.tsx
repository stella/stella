import { useRef, useState } from "react";

import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { PropertyContentType } from "@stella/api/types";
import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";

type CreatePropertyProps = {
  workspaceId: string;
};

export const CreateProperty = ({ workspaceId }: CreatePropertyProps) => {
  const t = useTranslations();
  const createProperty = useCreateProperty({ workspaceId });
  const isLimitReached = usePropertiesCountLimit(workspaceId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<PropertyContentType | null>(
    null,
  );
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  if (isLimitReached) {
    return null;
  }

  const openNamingDialog = (contentType: PropertyContentType) => {
    setSelectedType(contentType);
    setName("");
    setDialogOpen(true);
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed || !selectedType) {
      return;
    }

    createProperty.mutate(
      { name: trimmed, contentType: selectedType },
      {
        onSuccess: () => {
          setDialogOpen(false);
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              className="hover:bg-accent h-full! min-w-10 rounded-none"
              disabled={createProperty.isPending}
              size="icon"
              type="button"
              variant="ghost"
            />
          }
        >
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem
            className="text-sm"
            onClick={() => openNamingDialog("text")}
          >
            <PropertyIcon type="text" /> {t("workspaces.properties.text")}
          </MenuItem>
          <MenuItem
            className="text-sm"
            onClick={() => openNamingDialog("single-select")}
          >
            <PropertyIcon type="single-select" />{" "}
            {t("workspaces.properties.singleSelect")}
          </MenuItem>
          <MenuItem
            className="text-sm"
            onClick={() => openNamingDialog("multi-select")}
          >
            <PropertyIcon type="multi-select" />{" "}
            {t("workspaces.properties.multiSelect")}
          </MenuItem>
          <MenuItem
            className="text-sm"
            onClick={() => openNamingDialog("date")}
          >
            <PropertyIcon type="date" /> {t("workspaces.properties.date")}
          </MenuItem>
          <MenuItem className="text-sm" onClick={() => openNamingDialog("int")}>
            <PropertyIcon type="int" /> {t("workspaces.properties.int")}
          </MenuItem>
        </MenuPopup>
      </Menu>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogPopup className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workspaces.properties.nameProperty")}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 px-6 pb-4">
            {selectedType && (
              <PropertyIcon
                className="text-muted-foreground size-4 shrink-0"
                type={selectedType}
              />
            )}
            <Input
              autoComplete="off"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCreate();
                }
              }}
              placeholder={t("common.name")}
              ref={inputRef}
              value={name}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              disabled={!name.trim()}
              loading={createProperty.isPending}
              onClick={handleCreate}
            >
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
};
