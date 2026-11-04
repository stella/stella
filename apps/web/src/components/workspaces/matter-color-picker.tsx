import { useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
} from "@stll/ui/color-picker";
import {
  getMatterPickerColor,
  resolveMatterColor,
  toStoredMatterColor,
} from "@stll/ui/matter-colors";
import { Popover, PopoverPopup } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { notifyUserError } from "@/lib/errors/user-toast";
import { matterRouteView } from "@/lib/workspaces/archived-matters.logic";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";

type MatterColorIdentity = {
  color: string | null;
  id: string;
  /**
   * Required so no caller can offer the picker without knowing the matter is
   * writable: an archived matter is read-only, so it shows its icon only.
   */
  status: string;
};

const canChangeMatterColor = (matter: MatterColorIdentity) =>
  matterRouteView(matter.status) === "active";

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
  /** The matter icon; the picker supplies the named trigger button. */
  children: ReactNode;
  className?: string;
  label: string;
  matter: MatterColorIdentity;
};

type MatterColorContextPickerProps = {
  children: ReactNode;
  matter: MatterColorIdentity;
} & {
  className?: string;
} & (
    | {
        /** Focusable button: click, right-click, or keyboard opens the picker. */
        trigger?: "button";
        label: string;
      }
    | {
        /**
         * Right-click only. Renders an inert span so a parent link keeps
         * left click (used where the icon is the whole clickable item).
         */
        trigger: "contextmenu";
        label?: never;
      }
  );

const MatterColorPicker = (props: MatterColorPickerProps) => {
  if (!canChangeMatterColor(props.matter)) {
    return props.children;
  }
  return <WritableMatterColorPicker {...props} />;
};

const WritableMatterColorPicker = ({
  children,
  className,
  label,
  matter,
}: MatterColorPickerProps) => {
  const { moreLabel, selectColor } = useMatterColorPicker(matter);

  return (
    <ColorPicker
      defaultExpanded={false}
      moreLabel={moreLabel}
      onSelect={selectColor}
      trigger={
        <Button
          aria-label={label}
          className={className}
          size="icon-xs"
          variant="ghost"
        >
          {children}
        </Button>
      }
      value={getMatterPickerColor(matter.id, matter.color)}
    />
  );
};

const MatterColorContextPicker = (props: MatterColorContextPickerProps) => {
  if (!canChangeMatterColor(props.matter)) {
    return (
      <span
        className={cn(
          "relative flex shrink-0 items-center justify-center",
          props.className,
        )}
      >
        {props.children}
      </span>
    );
  }
  return <WritableMatterColorContextPicker {...props} />;
};

const WritableMatterColorContextPicker = ({
  children,
  className,
  matter,
  ...trigger
}: MatterColorContextPickerProps) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);

  const openPicker = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const triggerClassName = cn(
    "relative flex shrink-0 items-center justify-center rounded",
    className,
  );
  const content = (
    <>
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
    </>
  );

  return (
    <>
      {trigger.trigger === "contextmenu" ? (
        <span className={triggerClassName} onContextMenu={openPicker}>
          {content}
        </span>
      ) : (
        <Button
          aria-label={trigger.label}
          className={cn(
            "relative flex shrink-0 items-center justify-center",
            className,
          )}
          onClick={openPicker}
          onContextMenu={openPicker}
          variant="plain"
        >
          {content}
        </Button>
      )}
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
            notifyUserError(error, t("errors.actionFailed"));
          },
        },
      );
    },
  };
};

export { MatterColorContextPicker, MatterColorPicker };
