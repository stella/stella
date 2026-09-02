import type * as React from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { useTranslations } from "use-intl";

import {
  Sidebar as SidebarShell,
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
  SidebarProvider as SidebarProviderShell,
  SidebarRail as SidebarRailShell,
  SidebarSeparator,
  SidebarTrigger as SidebarTriggerShell,
  useSidebar,
  useSidebarInlineSize,
} from "@stll/ui/sidebar";

import { usePersistedSidebarOpen } from "@/hooks/use-persisted-sidebar-open";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";

const DEFAULT_SIDEBAR_OPEN = true;

/**
 * App glue around `@stll/ui/sidebar`'s generic shell: wires the app's
 * persisted (localStorage-backed) open state in as a controlled value. The
 * shell itself stays host-agnostic and does not persist anything on its own.
 */
const SidebarProvider = ({
  open: openProp,
  onOpenChange: setOpenProp,
  ...props
}: React.ComponentProps<typeof SidebarProviderShell>) => {
  // Read `defaultOpen` off the forwarded rest object (rather than destructuring
  // it out) so it reaches `SidebarProviderShell` exactly as received: with
  // `exactOptionalPropertyTypes`, re-attaching it from a `boolean | undefined`
  // local would widen the prop to explicit `undefined`, which the shell's
  // `defaultOpen?: boolean` rejects.
  const { defaultOpen } = props;
  const {
    open: persistedOpen,
    persistOpen,
    setOpen: setPersistedOpen,
  } = usePersistedSidebarOpen({
    defaultOpen: defaultOpen ?? DEFAULT_SIDEBAR_OPEN,
    hydrateFromStorage: defaultOpen === undefined && openProp === undefined,
  });

  const open = openProp ?? persistedOpen;
  const setOpen = (nextOpen: boolean) => {
    if (setOpenProp) {
      setOpenProp(nextOpen);
    } else {
      setPersistedOpen(nextOpen);
    }
    persistOpen(nextOpen);
  };

  return <SidebarProviderShell {...props} onOpenChange={setOpen} open={open} />;
};

/**
 * Registers the app's rebindable toggle-sidebar shortcut. The generic shell
 * exposes `toggleSidebar` via context but does not bind a hotkey itself,
 * since the binding (and its user-rebind support) is app-specific. Render
 * once as a child anywhere inside a `SidebarProvider` tree.
 */
const SidebarToggleHotkey = () => {
  const { toggleSidebar } = useSidebar();
  useHotkey(useEffectiveHotkey("toggleSidebar"), () => {
    toggleSidebar();
  });
  return null;
};

const Sidebar = (props: React.ComponentProps<typeof SidebarShell>) => {
  const t = useTranslations();

  return (
    <SidebarShell
      mobileDescription={t("navigation.sidebarDescription")}
      mobileTitle={t("navigation.sidebar")}
      {...props}
    />
  );
};

const SidebarTrigger = (
  props: React.ComponentProps<typeof SidebarTriggerShell>,
) => {
  const t = useTranslations();

  return (
    <SidebarTriggerShell label={t("navigation.toggleSidebar")} {...props} />
  );
};

const SidebarRail = (props: React.ComponentProps<typeof SidebarRailShell>) => {
  const t = useTranslations();

  return <SidebarRailShell label={t("navigation.toggleSidebar")} {...props} />;
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
  SidebarToggleHotkey,
  SidebarTrigger,
  useSidebar,
  useSidebarInlineSize,
};
