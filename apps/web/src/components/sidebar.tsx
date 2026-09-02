import { createContext, use, useId, useState } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { panic } from "better-result";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { PanelLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Separator } from "@stll/ui/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import {
  SIDEBAR_WIDTH_ICON_PX,
  SIDEBAR_WIDTH_PX,
} from "@/components/sidebar-sizing";
import { usePersistedSidebarOpen } from "@/hooks/use-persisted-sidebar-open";
import { Slot } from "@/lib/slot";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";

const REM_PX = 16;
const SIDEBAR_WIDTH = `${SIDEBAR_WIDTH_PX / REM_PX}rem`;
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = `${SIDEBAR_WIDTH_ICON_PX / REM_PX}rem`;
const DEFAULT_SIDEBAR_OPEN = true;

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
 * Inline size the app sidebar takes out of the layout row, in CSS pixels.
 * Panes docked to the opposite edge need this to know how much room is
 * actually left for the content column. Mobile reports 0: there the
 * sidebar is an overlay sheet and occupies no layout width.
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

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const {
    open: persistedOpen,
    persistOpen,
    setOpen: setPersistedOpen,
  } = usePersistedSidebarOpen({
    defaultOpen: defaultOpen ?? DEFAULT_SIDEBAR_OPEN,
    hydrateFromStorage: defaultOpen === undefined && openProp === undefined,
  });
  const _open = persistedOpen;
  const requestedOpen = openProp ?? _open;
  const open = requestedOpen && !forceCollapsed;
  const setOpen = (value: boolean | ((v: boolean) => boolean)) => {
    const openState =
      typeof value === "function" ? value(requestedOpen) : value;
    if (setOpenProp) {
      setOpenProp(openState);
    } else {
      setPersistedOpen(openState);
    }
    persistOpen(openState);
  };

  // Helper to toggle the sidebar.
  const toggleSidebar = () =>
    isMobile
      ? setOpenMobile((isOpen) => !isOpen)
      : setOpen((isOpen) => !isOpen);

  useHotkey(useEffectiveHotkey("toggleSidebar"), () => {
    toggleSidebar();
  });

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed";

  const contextValue: SidebarContextProps = {
    state,
    open,
    setOpen,
    isMobile,
    openMobile,
    setOpenMobile,
    toggleSidebar,
  };

  return (
    <SidebarContext value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full",
          className,
        )}
        data-slot="sidebar-wrapper"
        style={{
          "--sidebar-width": SIDEBAR_WIDTH,
          "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
          ...style,
        }}
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
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
}) => {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const t = useTranslations();

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
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
        <SheetPopup
          className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
          data-mobile="true"
          data-sidebar="sidebar"
          data-slot="sidebar"
          side={side === "left" ? "inline-start" : "inline-end"}
          style={{
            "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
          }}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("navigation.sidebar")}</SheetTitle>
            <SheetDescription>
              {t("navigation.sidebarDescription")}
            </SheetDescription>
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
  ...props
}: React.ComponentProps<typeof Button>) => {
  const { toggleSidebar } = useSidebar();
  const t = useTranslations();

  return (
    <Button
      aria-label={t("navigation.toggleSidebar")}
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
      <span className="sr-only">{t("navigation.toggleSidebar")}</span>
    </Button>
  );
};

const SidebarRail = ({
  className,
  ...props
}: React.ComponentProps<"button">) => {
  const { toggleSidebar } = useSidebar();
  const t = useTranslations();

  return (
    <button
      aria-label={t("navigation.toggleSidebar")}
      type="button"
      className={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-[transform,background-color] ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] sm:flex",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
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
  "peer/menu-button ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:hover:bg-sidebar-accent data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-start text-sm outline-hidden transition-[width,height,padding,border-radius] group-has-data-[sidebar=menu-action]/menu-item:pe-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:font-medium group-data-[collapsible=icon]:[&>*:not(:first-child)]:hidden [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
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
        hidden={state !== "collapsed" || isMobile}
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
  const width = skeletonWidthFromId(skeletonId);

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
        style={{
          "--skeleton-width": width,
        }}
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
