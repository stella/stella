import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon, XIcon } from "@stll/ui/icons";
import { MenuTrigger } from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { getInspectorTabSwitcherHandle } from "@/components/inspector/inspector-tab-switcher-handle";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useFormatter } from "@/i18n/formatting-context";

/*
 * The inspector tab header's frame and its phone navigation, shared by every
 * tab's header and by the header the phone sheet shows while the inspector's
 * code loads. Both draw the same row from these pieces, so the header keeps
 * its geometry when the loaded one replaces the pending one.
 *
 * This module stays small: the signed-in app chrome imports it for that
 * pending header.
 */

type InspectorTabHeaderFrameProps = {
  /** The row's start: the phone navigation, then the tab's name. */
  lead: ReactNode;
  /** Clips the lead. Off while a rename field draws its focus ring outside
   *  the row. */
  clipLead: boolean;
  /** The row's end (actions and close); `null` while renaming, when the name
   *  needs the whole row. */
  trailing: ReactNode;
};

export const InspectorTabHeaderFrame = ({
  clipLead,
  lead,
  trailing,
}: InspectorTabHeaderFrameProps) => (
  <div
    className="flex h-12 shrink-0 items-center justify-between border-b bg-(--matter-sidebar-tint) px-3"
    data-slot="inspector-panel-header"
  >
    {/* On a phone the lead starts a little early, so the back button sits
        optically flush with the edge and is not clipped. */}
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 max-md:-ms-1",
        clipLead && "overflow-hidden",
      )}
    >
      {lead}
    </div>
    {trailing === null ? null : (
      <div className="flex shrink-0 items-center gap-1 ps-4">{trailing}</div>
    )}
  </div>
);

type InspectorPhoneNavigationProps = {
  className?: string | undefined;
  /** The tab switcher: `InspectorTabSwitcherTrigger` once the inspector has
   *  loaded, a disabled `InspectorTabSwitcherButton` before. */
  switcher: ReactNode;
};

/**
 * What a phone has in place of the rail: Back, which returns to the page
 * behind the inspector sheet, and the tab switcher. Hidden from `md` up,
 * where the rail is on screen.
 */
export const InspectorPhoneNavigation = ({
  className,
  switcher,
}: InspectorPhoneNavigationProps) => {
  const tCommon = useTranslations("common");
  const setMinimized = useInspectorTabsStore((s) => s.setMinimized);
  return (
    // The gap keeps the two buttons' 44px touch areas apart.
    <div
      className={cn("flex shrink-0 items-center gap-3 md:hidden", className)}
      data-slot="inspector-phone-navigation"
    >
      <Button
        aria-label={tCommon("back")}
        onClick={() => setMinimized(true)}
        size="icon-sm"
        title={tCommon("back")}
        variant="ghost"
      >
        <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
      </Button>
      {switcher}
    </div>
  );
};

type InspectorTabSwitcherButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant"
>;

/**
 * The tab switcher's button: the number of open tabs in a tab-shaped frame.
 * The live switcher renders it as its menu trigger; the pending header
 * renders it disabled, so both have one size and one name.
 */
const InspectorTabSwitcherButton = (props: InspectorTabSwitcherButtonProps) => {
  const t = useTranslations("inspector");
  const format = useFormatter();
  const count = useInspectorTabsStore((s) => s.tabs.length);
  return (
    <Button
      aria-label={t("openTabs", { count })}
      {...props}
      // Pinned after the spread: the menu trigger hands in its own slot, and
      // this one names the control in both phases.
      data-slot="inspector-tab-switcher"
      size="icon-sm"
      variant="ghost"
    >
      <span
        aria-hidden="true"
        className="text-3xs flex h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-current px-0.5 leading-none font-semibold tabular-nums"
      >
        {format.number(count)}
      </span>
    </Button>
  );
};

// Mounted triggers register, so the menu can hand focus to the one on screen.
const registerTrigger = (element: HTMLElement | null) => {
  const { triggers } = getInspectorTabSwitcherHandle();
  if (element !== null) {
    triggers.add(element);
  }
  return () => {
    if (element !== null) {
      triggers.delete(element);
    }
  };
};

/**
 * Opens the inspector's tab switcher. Every tab header renders one, and they
 * all open the one menu the panel mounts (`InspectorTabSwitcherMenu`):
 * switching tabs replaces the header the reader pressed, and a menu inside it
 * would go with it.
 */
export const InspectorTabSwitcherTrigger = () => (
  <MenuTrigger
    handle={getInspectorTabSwitcherHandle().menu}
    ref={registerTrigger}
    render={<InspectorTabSwitcherButton />}
  />
);

/**
 * A tab header before the inspector's code has loaded: the loaded header's
 * frame, with Back, the switcher and Close where it has them. Back works
 * already; the switcher and Close wait for the panel.
 */
export const InspectorTabHeaderPending = () => {
  const tCommon = useTranslations("common");
  return (
    <InspectorTabHeaderFrame
      clipLead
      lead={
        <>
          <InspectorPhoneNavigation
            switcher={
              <InspectorTabSwitcherButton
                disabled
                disabledReason={tCommon("loading")}
              />
            }
          />
          <Skeleton className="h-4 w-32" />
        </>
      }
      trailing={
        <Button
          aria-label={tCommon("close")}
          disabled
          disabledReason={tCommon("loading")}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      }
    />
  );
};
