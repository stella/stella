import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
} from "@stll/ui/components/color-picker";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { userErrorFromThrown } from "@/lib/errors/user-safe";
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
  const { moreLabel, selectColor } = useMatterColorPicker(matter);

  return (
    <ColorPickerContent
      columns={9}
      defaultExpanded={false}
      moreLabel={moreLabel}
      onSelect={selectColor}
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
  label: string;
};

const MatterColorPicker = ({ children, matter }: MatterColorPickerProps) => {
  const { moreLabel, selectColor } = useMatterColorPicker(matter);

  return (
    <ColorPicker
      defaultExpanded={false}
      moreLabel={moreLabel}
      onSelect={selectColor}
      value={getMatterPickerColor(matter.id, matter.color)}
    >
      {children}
    </ColorPicker>
  );
};

const MatterColorContextPicker = ({
  children,
  className,
  label,
  matter,
}: MatterColorContextPickerProps) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);

  const openPicker = () => setOpen(true);

  return (
    <>
      <button
        aria-label={label}
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded outline-hidden focus-visible:ring-2",
          className,
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openPicker();
        }}
        type="button"
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
        <span className="relative flex" ref={setAnchor}>
          {children}
        </span>
      </button>
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

const useMatterColorPicker = (matter: MatterColorIdentity) => {
  const t = useTranslations();
  const updateWorkspace = useUpdateWorkspace();

  return {
    moreLabel: t("common.showMore"),
    selectColor: (color: string) => {
      updateWorkspace.mutate(
        {
          workspaceId: matter.id,
          update: { type: "color", value: toStoredMatterColor(color) },
        },
        {
          onError: (error) => {
            stellaToast.add({
              title: userErrorFromThrown(error, t("errors.actionFailed")),
              type: "error",
            });
          },
        },
      );
    },
  };
};

export {
  MatterColorContextPicker,
  MatterColorPicker,
  MatterColorPickerContent,
};
