import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
} from "@stll/ui/components/color-picker";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import {
  getMatterPickerColor,
  resolveMatterColor,
  toStoredMatterColor,
} from "@/lib/matter-colors";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";

type MatterColorIdentity = {
  color: string | null;
  id: string;
};

type MatterColorPickerContentProps = {
  matter: MatterColorIdentity;
};

const MatterColorPickerContent = ({
  matter,
}: MatterColorPickerContentProps) => {
  const t = useTranslations();
  const updateWorkspace = useUpdateWorkspace();

  return (
    <ColorPickerContent
      columns={9}
      defaultExpanded={false}
      moreLabel={t("common.showMore")}
      onSelect={(color) => {
        updateWorkspace.mutate({
          workspaceId: matter.id,
          update: { type: "color", value: toStoredMatterColor(color) },
        });
      }}
      presets={DEFAULT_PRESETS}
      value={getMatterPickerColor(matter.id, matter.color)}
    />
  );
};

type MatterColorPickerProps = {
  children: ReactNode;
  matter: MatterColorIdentity;
};

type MatterColorContextPickerProps = MatterColorPickerProps & {
  className?: string;
};

const MatterColorPicker = ({ children, matter }: MatterColorPickerProps) => {
  const t = useTranslations();
  const updateWorkspace = useUpdateWorkspace();

  return (
    <ColorPicker
      defaultExpanded={false}
      moreLabel={t("common.showMore")}
      onSelect={(color) => {
        updateWorkspace.mutate({
          workspaceId: matter.id,
          update: { type: "color", value: toStoredMatterColor(color) },
        });
      }}
      value={getMatterPickerColor(matter.id, matter.color)}
    >
      {children}
    </ColorPicker>
  );
};

const MatterColorContextPicker = ({
  children,
  className,
  matter,
}: MatterColorContextPickerProps) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);

  return (
    <>
      <span
        className={cn("relative flex shrink-0", className)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        ref={setAnchor}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-1 rounded-md opacity-0 motion-reduce:animate-none",
            open && "animate-attention-flash",
          )}
          style={{
            backgroundColor: `color-mix(in srgb, ${resolveMatterColor(matter.id, matter.color)} 18%, transparent)`,
          }}
        />
        <span className="relative flex">{children}</span>
      </span>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverPopup
          align="start"
          anchor={anchor}
          className="w-auto"
          onClick={(event) => event.stopPropagation()}
          sideOffset={8}
        >
          <MatterColorPickerContent matter={matter} />
        </PopoverPopup>
      </Popover>
    </>
  );
};

export {
  MatterColorContextPicker,
  MatterColorPicker,
  MatterColorPickerContent,
};
