"use client";

import { createContext, use, useId, useState } from "react";
import type { CSSProperties } from "react";

import { panic } from "better-result";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { PanelLeftIcon } from "lucide-react";

import { useIsMobile } from "../hooks/use-mobile";
import { Slot } from "../lib/slot";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Separator } from "./separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "./sheet";
import {
  deriveSidebarState,
  isSidebarMenuButtonTooltipVisible,
  nextOpenMobile,
  nextRequestedOpen,
  resolveSidebarOpen,
} from "./sidebar.logic";
import { Skeleton } from "./skeleton";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "./tooltip";

/**
 * Inline size the sidebar takes out of the layout row when expanded, in CSS
 * pixels. Kept equal across the two rail-shaped primitives in this package:
 * `SIDE_RAIL_WIDTH` (inspector) and `APPLICATION_RAIL_WIDTH` are both `w-12`
 * (48px), the same as {@link SIDEBAR_WIDTH_ICON_PX} below, so a collapsed
 * sidebar lines up with either rail.
 */
export const SIDEBAR_WIDTH_PX = 256;

/** Inline size of the collapsed ("icon") rail, in CSS pixels. See above. */
export const SIDEBAR_WIDTH_ICON_PX = 48;

const REM_PX = 16;
const SIDEBAR_WIDTH = `${SIDEBAR_WIDTH_PX / REM_PX}rem`;
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = `${SIDEBAR_WIDTH_ICON_PX / REM_PX}rem`;
const DEFAULT_SIDEBAR_OPEN = true;
const DEFAULT_TOGGLE_LABEL = "Toggle Sidebar";
const DEFAULT_MOBILE_TITLE = "Sidebar";
const DEFAULT_MOBILE_DESCRIPTION = "Displays the mobile sidebar.";

/**
 * React's `CSSProperties` has no key for a custom property, so the variables
 * the shell sets are named here, on a local style type, rather than through
 * a module augmentation: an augmentation only holds inside the program that
 * declares it, and a consumer compiling this file from source (a workspace
 * package, a host on the source export) would lose it.
 */
type SidebarStyle = CSSProperties & {
  "--sidebar-width"?: string;
  "--sidebar-width-icon"?: string;
};

type SidebarSkeletonStyle = CSSProperties & {
  "--skeleton-width"?: string;
};

const skeletonWidthFromId = (id: string): string => {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 40;
  }
  return `${hash + 50}%`;
};

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = use(SidebarContext);
  if (!context) {
    panic("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

/**
 * Inline size the sidebar takes out of the layout row, in CSS pixels. Panes
 * docked to the opposite edge need this to know how much room is actually
 * left for the content column. Mobile reports 0: there the sidebar is an
 * overlay sheet and occupies no layout width.
 */
function useSidebarInlineSize() {
  const { isMobile, state } = useSidebar();

  if (isMobile) {
    return 0;
  }
  return state === "expanded" ? SIDEBAR_WIDTH_PX : SIDEBAR_WIDTH_ICON_PX;
}

const SidebarProvider = ({
  defaultOpen,
  forceCollapsed = false,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  forceCollapsed?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = useState(false);

  // This is the internal state of the sidebar, used when the host does not
  // control `open` itself. `open`/`onOpenChange` let a host own persistence
  // (localStorage, a cookie, a query param) instead.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen ?? DEFAULT_SIDEBAR_OPEN,
  );
  const requestedOpen = openProp ?? uncontrolledOpen;
  const open = resolveSidebarOpen({ forceCollapsed, requestedOpen });
  const setOpen = (value: boolean | ((v: boolean) => boolean)) => {
    const openState =
      typeof value === "function" ? value(requestedOpen) : value;
    if (setOpenProp) {
      setOpenProp(openState);
    } else {
      setUncontrolledOpen(openState);
    }
  };

  // Helper to toggle the sidebar.
  const toggleSidebar = () =>
    isMobile ? setOpenMobile(nextOpenMobile) : setOpen(nextRequestedOpen);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = deriveSidebarState(open);

  const contextValue: SidebarContextProps = {
    state,
    open,
    setOpen,
    isMobile,
    openMobile,
    setOpenMobile,
    toggleSidebar,
  };

  const wrapperStyle: SidebarStyle = {
    "--sidebar-width": SIDEBAR_WIDTH,
    "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
    ...style,
  };

  return (
    <SidebarContext value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full",
          className,
        )}
        data-slot="sidebar-wrapper"
        style={wrapperStyle}
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  );
};

const Sidebar = ({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  mobileTitle = DEFAULT_MOBILE_TITLE,
  mobileDescription = DEFAULT_MOBILE_DESCRIPTION,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * Which edge the sidebar docks to. Despite the physical name, this is
   * applied as a *logical* position: `"left"` docks at the CSS inline-start
   * edge and `"right"` docks at the inline-end edge (see the `start-0` /
   * `end-0` classes below, keyed off `data-side`). Under `dir="rtl"` a
   * `side="left"` sidebar therefore renders on the visual right, mirroring
   * the reading direction rather than a fixed screen edge. `SidebarRail`
   * derives its content-facing offset from `data-side` using the same
   * left→end / right→start mapping so it keeps tracking the boundary
   * between the sidebar and the content pane in both directions.
   */
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  /** Screen-reader title for the mobile sheet. Override to localize. */
  mobileTitle?: string;
  /** Screen-reader description for the mobile sheet. Override to localize. */
  mobileDescription?: string;
}) => {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === "none") {
    return (
      <div
        className={cn(
          "bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col",
          className,
        )}
        data-slot="sidebar"
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    const mobileStyle: SidebarStyle = {
      "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
    };
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
        <SheetPopup
          className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
          data-mobile="true"
          data-sidebar="sidebar"
          data-slot="sidebar"
          side={side === "left" ? "inline-start" : "inline-end"}
          style={mobileStyle}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{mobileTitle}</SheetTitle>
            <SheetDescription>{mobileDescription}</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-side={side}
      data-slot="sidebar"
      data-state={state}
      data-variant={variant}
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
        data-slot="sidebar-gap"
      />
      <div
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[inset-inline-start,inset-inline-end,width] duration-200 ease-linear md:flex",
          side === "left"
            ? "start-0 group-data-[collapsible=offcanvas]:start-[calc(var(--sidebar-width)*-1)]"
            : "end-0 group-data-[collapsible=offcanvas]:end-[calc(var(--sidebar-width)*-1)]",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-e group-data-[side=right]:border-s",
          className,
        )}
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className="bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm"
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
};

const SidebarTrigger = ({
  className,
  onClick,
  label = DEFAULT_TOGGLE_LABEL,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof Button> & {
  /** Accessible name for the trigger. Override to localize. */
  label?: string;
}) => {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      aria-label={ariaLabel ?? label}
      className={cn("size-7", className)}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon"
      variant="ghost"
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">{label}</span>
    </Button>
  );
};

const SidebarRail = ({
  className,
  label = DEFAULT_TOGGLE_LABEL,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<"button"> & {
  /** Accessible name for the rail. Override to localize. */
  label?: string;
}) => {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      aria-label={ariaLabel ?? label}
      type="button"
      className={cn(
        // `side` docks the sidebar at a logical edge (see the doc comment on
        // `Sidebar`'s `side` prop): "left" -> inline-start, "right" ->
        // inline-end. The rail must sit on the content-facing boundary, i.e.
        // the *opposite* logical edge from where the sidebar itself docks,
        // so data-side=left -> end-* and data-side=right -> start-*. Using
        // start-*/end-* here (instead of the old left-*/right-*) makes that
        // boundary track the sidebar's docked edge under dir="rtl" too.
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 transition-[transform,background-color] ease-linear group-data-[side=left]:-end-4 group-data-[side=right]:start-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] sm:flex",
        // `translate` is a raw physical-pixel transform (it never mirrors
        // with `dir` the way inset-inline-* properties do), so centering the
        // rail on the boundary line needs its sign flipped per direction
        // rather than per side: ltr always needs a leftward shift here and
        // rtl always needs a rightward one, for either side value.
        "ltr:-translate-x-1/2 rtl:translate-x-1/2",
        // Resize-cursor icons have no logical CSS equivalent (there is no
        // "cursor: inline-resize"), so these stay keyed to the physical side
        // the cursor should visually point toward.
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "hover:group-data-[collapsible=offcanvas]:bg-sidebar",
        // Same tie-break concern as the base transform above: explicitly pair
        // the offcanvas override with each direction so its two-attribute
        // specificity always beats the single-attribute dir variant, instead
        // of depending on generated stylesheet order.
        "group-data-[collapsible=offcanvas]:ltr:translate-x-0 group-data-[collapsible=offcanvas]:rtl:translate-x-0",
        // The hover highlight bar should land on the rail's own content-facing
        // edge too, which is the same left->end / right->start mapping as
        // the base offset above.
        "group-data-[collapsible=offcanvas]:group-data-[side=left]:after:end-full group-data-[collapsible=offcanvas]:group-data-[side=right]:after:start-full",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-end-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-start-2",
        className,
      )}
      data-sidebar="rail"
      data-slot="sidebar-rail"
      onClick={toggleSidebar}
      tabIndex={-1}
      {...props}
    />
  );
};

const SidebarInset = ({
  className,
  ...props
}: React.ComponentProps<"main">) => (
  <main
    className={cn(
      "bg-background relative flex w-full flex-1 flex-col overflow-hidden",
      "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2",
      className,
    )}
    data-slot="sidebar-inset"
    {...props}
  />
);

const SidebarInput = ({
  className,
  ...props
}: React.ComponentProps<typeof Input>) => (
  <Input
    className={cn("bg-background h-8 w-full shadow-none", className)}
    data-sidebar="input"
    data-slot="sidebar-input"
    {...props}
  />
);

const SidebarHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex flex-col gap-2 p-2", className)}
    data-sidebar="header"
    data-slot="sidebar-header"
    {...props}
  />
);

const SidebarFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex flex-col gap-2 p-2", className)}
    data-sidebar="footer"
    data-slot="sidebar-footer"
    {...props}
  />
);

const SidebarSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) => (
  <Separator
    className={cn("bg-sidebar-border w-auto", className)}
    data-sidebar="separator"
    data-slot="sidebar-separator"
    {...props}
  />
);

const SidebarContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto group-data-[collapsible=icon]:[scrollbar-width:none] group-data-[collapsible=icon]:[&::-webkit-scrollbar]:hidden",
      className,
    )}
    data-sidebar="content"
    data-slot="sidebar-content"
    {...props}
  />
);

const SidebarGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
    data-sidebar="group"
    data-slot="sidebar-group"
    {...props}
  />
);

const SidebarGroupLabel = ({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) => {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      className={cn(
        "text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="group-label"
      data-slot="sidebar-group-label"
      {...props}
    />
  );
};

const SidebarGroupAction = ({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) => {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={cn(
        "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute end-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="group-action"
      data-slot="sidebar-group-action"
      {...props}
    />
  );
};

const SidebarGroupContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("w-full text-sm", className)}
    data-sidebar="group-content"
    data-slot="sidebar-group-content"
    {...props}
  />
);

const SidebarMenu = ({ className, ...props }: React.ComponentProps<"ul">) => (
  <ul
    className={cn("flex w-full min-w-0 flex-col gap-1", className)}
    data-sidebar="menu"
    data-slot="sidebar-menu"
    {...props}
  />
);

const SidebarMenuItem = ({
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    className={cn("group/menu-item relative", className)}
    data-sidebar="menu-item"
    data-slot="sidebar-menu-item"
    {...props}
  />
);

const sidebarMenuButtonVariants = cva(
  "peer/menu-button ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:hover:bg-sidebar-accent data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-start text-sm outline-hidden transition-[width,height,padding,border-radius] group-has-data-[sidebar=menu-action]/menu-item:pe-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:font-medium [&>span:last-child]:truncate [&>span:last-child]:transition-opacity [&>span:last-child]:duration-200 group-data-[collapsible=icon]:[&>span:last-child]:opacity-0 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm",
        /** A 44px target in both states, for a sidebar that stands in for
         * the application rail on touch and hybrid devices. */
        rail: "h-11 text-sm group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:justify-center",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const SidebarMenuButton = ({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
} & VariantProps<typeof sidebarMenuButtonVariants>) => {
  const Comp = asChild ? Slot : "button";
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      data-active={isActive}
      data-sidebar="menu-button"
      data-size={size}
      data-slot="sidebar-menu-button"
      {...props}
    />
  );

  if (tooltip === undefined) {
    return button;
  }

  const tooltipProps =
    typeof tooltip === "string" ? { children: tooltip } : tooltip;

  return (
    <TooltipRoot>
      <TooltipTrigger render={button} />
      <TooltipPopup
        align="center"
        hidden={!isSidebarMenuButtonTooltipVisible({ isMobile, state })}
        side="right"
        {...tooltipProps}
      />
    </TooltipRoot>
  );
};

const SidebarMenuAction = ({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) => {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={cn(
        "text-sidebar-foreground ring-sidebar-ring peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute end-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 outline-hidden transition-transform focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0",
        className,
      )}
      data-sidebar="menu-action"
      data-slot="sidebar-menu-action"
      {...props}
    />
  );
};

const SidebarMenuBadge = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "text-sidebar-foreground pointer-events-none absolute end-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums select-none",
      "peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
      "peer-data-[size=sm]/menu-button:top-1",
      "peer-data-[size=default]/menu-button:top-1.5",
      "peer-data-[size=lg]/menu-button:top-2.5",
      "transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0",
      className,
    )}
    data-sidebar="menu-badge"
    data-slot="sidebar-menu-badge"
    {...props}
  />
);

const SidebarMenuSkeleton = ({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) => {
  const skeletonId = useId();
  const textStyle: SidebarSkeletonStyle = {
    "--skeleton-width": skeletonWidthFromId(skeletonId),
  };

  return (
    <div
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={textStyle}
      />
    </div>
  );
};

const SidebarMenuSub = ({
  className,
  ...props
}: React.ComponentProps<"ul">) => (
  <ul
    className={cn(
      "border-sidebar-border mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-s px-2.5 py-0.5",
      "group-data-[collapsible=icon]:hidden",
      className,
    )}
    data-sidebar="menu-sub"
    data-slot="sidebar-menu-sub"
    {...props}
  />
);

const SidebarMenuSubItem = ({
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    className={cn("group/menu-sub-item relative", className)}
    data-sidebar="menu-sub-item"
    data-slot="sidebar-menu-sub-item"
    {...props}
  />
);

const SidebarMenuSubButton = ({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
  size?: "sm" | "md";
  isActive?: boolean;
}) => {
  const Comp = asChild ? Slot : "a";

  return (
    <Comp
      className={cn(
        "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
        size === "sm" && "text-xs",
        size === "md" && "text-sm",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-active={isActive}
      data-sidebar="menu-sub-button"
      data-size={size}
      data-slot="sidebar-menu-sub-button"
      {...props}
    />
  );
};

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  useSidebarInlineSize,
};
