import { createContext, use } from "react";
import type { ReactElement, ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  BrainIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  KeyboardIcon,
  MonitorIcon,
  PlugIcon,
  UserIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/*
 * The settings area's chrome, drawn by both phases: the account section of
 * the navigation (`./settings-nav.ts` adds the organization's and decides
 * which rows a member sees), the
 * layout of the narrow-screen menu row, the navigation column and the
 * content column, and the classes their rows use. `SettingsShell` fills it
 * with the live menu, links and scroll areas. A settings page's pending view
 * wraps itself in `SettingsPagePending`: inside the live shell (a navigation
 * between settings pages) that is the page alone; drawn by the cold-load
 * frame, before the shell mounts, it is the page inside this chrome in its
 * pending phase, so the content column is where the shell will put it.
 */

// Literal keys keep t() from demanding ICU values a widened
// TranslationKey would require.
export const ACCOUNT_SECTION = {
  id: "account",
  labelKey: "settings.account.title",
  items: [
    {
      to: "/settings/account/profile",
      labelKey: "common.profile",
      icon: UserIcon,
    },
    {
      to: "/settings/account/desktop",
      labelKey: "settings.account.desktop",
      icon: MonitorIcon,
    },
    {
      to: "/settings/account/connections",
      labelKey: "settings.connections.title",
      icon: PlugIcon,
    },
    {
      // Personal + firm + matter memory in one panel. RLS scopes what each
      // member sees; firm-library creation is gated inside the panel.
      to: "/settings/account/memory",
      labelKey: "memory.pageTitle",
      icon: BrainIcon,
      gate: "memory",
    },
    {
      to: "/settings/account/beta",
      labelKey: "settings.account.beta",
      icon: FlaskConicalIcon,
      gate: "beta",
    },
  ],
} as const;

/** A navigation row: a link, or the shortcuts button's face. */
export const SETTINGS_NAV_ITEM_CLASS = cn(
  "hover:bg-sidebar-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden",
  "focus-visible:ring-ring focus-visible:ring-2",
);

/** A navigation section's caption. */
export const SETTINGS_NAV_SECTION_LABEL_CLASS =
  "text-muted-foreground px-2 py-1 text-xs font-medium tracking-wide uppercase";

/** The navigation's sections, stacked. */
export const SETTINGS_NAV_CLASS = "flex flex-col gap-4 p-3";

/** One navigation section: its caption over its rows. */
export const SETTINGS_NAV_SECTION_CLASS = "flex flex-col gap-1";

/** The content column's scroll area: the space the navigation leaves. */
const SETTINGS_CONTENT_SCROLL_CLASS = "min-h-0 min-w-0 flex-1";

type SettingsShellLayoutProps = {
  /** The narrow-screen menu that stands for the navigation column. */
  mobileMenu: ReactNode;
  /** The navigation column's content (its scroll area). */
  nav: ReactNode;
  /** The content column (its scroll area). */
  children: ReactNode;
};

/** The settings area's three regions, in both phases. */
export const SettingsShellLayout = ({
  children,
  mobileMenu,
  nav,
}: SettingsShellLayoutProps) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
    <div className="shrink-0 border-b p-3 md:hidden">{mobileMenu}</div>
    <div className="bg-muted/30 hidden w-60 shrink-0 border-e md:block">
      {nav}
    </div>
    {children}
  </div>
);

/** The page column inside the content scroll area. */
export const SettingsContent = ({ children }: { children: ReactNode }) => (
  <section className="flex min-w-0 flex-col">
    {/* One width for every page: organization tables need it, and
        moving between sections never shifts the content. */}
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      {children}
    </div>
  </section>
);

/** The navigation before the member is known: the account rows all see. */
const SettingsNavPending = () => (
  <div className={SETTINGS_NAV_CLASS}>
    <div className={SETTINGS_NAV_SECTION_CLASS}>
      <div className={SETTINGS_NAV_SECTION_LABEL_CLASS}>
        <PendingText barClassName="w-16" id={ACCOUNT_SECTION.labelKey} />
      </div>
      {ACCOUNT_SECTION.items.map((item) => {
        if ("gate" in item) {
          return null;
        }
        const Icon = item.icon;
        return (
          <span className={SETTINGS_NAV_ITEM_CLASS} key={item.to}>
            <Icon className="size-4" />
            <span>
              <PendingText barClassName="w-20" id={item.labelKey} />
            </span>
          </span>
        );
      })}
      <span className="block w-full">
        <span className={SETTINGS_NAV_ITEM_CLASS}>
          <KeyboardIcon className="size-4" />
          <span>
            <PendingText
              barClassName="w-28"
              id="navigation.shortcutsDialog.title"
            />
          </span>
        </span>
      </span>
    </div>
  </div>
);

/** The settings chrome with the page's pending view in its content column. */
const SettingsShellPending = ({ children }: { children: ReactNode }) => (
  <SettingsShellLayout
    mobileMenu={
      <ButtonFace
        className="w-full justify-between"
        size="default"
        variant="outline"
      >
        <FaceLabelPending className="w-24" />
        <ChevronDownIcon className="size-4 shrink-0" />
      </ButtonFace>
    }
    nav={
      <div className="h-full overflow-hidden">
        <SettingsNavPending />
      </div>
    }
  >
    <div className={cn(SETTINGS_CONTENT_SCROLL_CLASS, "overflow-hidden")}>
      <SettingsContent>{children}</SettingsContent>
    </div>
  </SettingsShellLayout>
);

// Whether the live settings shell is above: its content column already holds
// the page.
const SettingsChromeContext = createContext(false);

/** Marks the live shell's content column (`SettingsShell`). */
export const SettingsChromeScope = ({ children }: { children: ReactNode }) => (
  <SettingsChromeContext value>{children}</SettingsChromeContext>
);

/**
 * A settings page's pending view: the page alone inside the live shell, and
 * the page inside the shell's pending chrome where the shell is not mounted
 * yet (the cold-load frame), so the page sits in the same column either way.
 */
export const SettingsPagePending = ({
  children,
}: {
  children: ReactElement;
}): ReactElement =>
  use(SettingsChromeContext) ? (
    children
  ) : (
    <SettingsShellPending>{children}</SettingsShellPending>
  );
