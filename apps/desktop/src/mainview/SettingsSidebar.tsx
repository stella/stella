import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ActivityIcon,
  BellIcon,
  ClipboardIcon,
  CpuIcon,
  DictateIcon,
  InfoIcon,
  ShieldIcon,
  SignatureIcon,
  SlidersHorizontalIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { accountDisplay, accountStatusTone } from "./account-presentation";
import type { DesktopAccountState } from "./account-presentation";
import { AccountAvatar } from "./AccountAvatar";
import { SETTINGS_PAGES_AFTER_DIVIDER } from "./settings-pages";
import type { SettingsPage } from "./settings-pages";

/**
 * The Settings window's navigation: who this computer is linked as, then
 * one entry per page. Only the content beside it scrolls.
 */
export const SettingsSidebar = ({
  accountState,
  current,
  onSelect,
  pages,
  topInset,
}: {
  accountState: DesktopAccountState;
  current: SettingsPage;
  onSelect: (page: SettingsPage) => void;
  /** The pages this account and computer offer, in sidebar order. */
  pages: readonly SettingsPage[];
  /** Room for the macOS window buttons drawn over the page. */
  topInset: "titleBar" | "none";
}) => {
  const t = useTranslations("settings");
  const before = pages.filter((page) => !isAfterDivider(page));
  const after = pages.filter(isAfterDivider);

  return (
    <aside
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex w-51 shrink-0 flex-col gap-3 overflow-hidden border-e px-4 pb-3",
        topInset === "titleBar" ? "pt-11" : "pt-3",
      )}
    >
      <SidebarIdentity
        accountState={accountState}
        onOpen={() => {
          onSelect("general");
        }}
      />
      <nav aria-label={t("title")} className="flex flex-col gap-2">
        <SidebarPages current={current} onSelect={onSelect} pages={before} />
        {after.length > 0 ? (
          <>
            <div aria-hidden="true" className="bg-sidebar-border mx-1.5 h-px" />
            <SidebarPages current={current} onSelect={onSelect} pages={after} />
          </>
        ) : null}
      </nav>
    </aside>
  );
};

const isAfterDivider = (page: SettingsPage) =>
  SETTINGS_PAGES_AFTER_DIVIDER.some((after) => after === page);

const PAGE_ICONS = {
  about: InfoIcon,
  activity: ActivityIcon,
  agents: CpuIcon,
  clipboard: ClipboardIcon,
  dictation: DictateIcon,
  general: SlidersHorizontalIcon,
  notifications: BellIcon,
  permissions: ShieldIcon,
  signing: SignatureIcon,
} as const satisfies Record<SettingsPage, LucideIcon>;

const SidebarPages = ({
  current,
  onSelect,
  pages,
}: {
  current: SettingsPage;
  onSelect: (page: SettingsPage) => void;
  pages: readonly SettingsPage[];
}) => {
  const t = useTranslations("settings.pages");
  return (
    <ul className="flex flex-col gap-0.5">
      {pages.map((page) => {
        const Icon = PAGE_ICONS[page];
        const isCurrent = page === current;
        return (
          <li key={page}>
            <Button
              aria-current={isCurrent ? "page" : undefined}
              className="w-full justify-start gap-2.5 px-2 font-normal data-pressed:font-medium"
              data-page={page}
              onClick={() => {
                onSelect(page);
              }}
              selected={isCurrent}
              variant="ghost"
            >
              <Icon
                aria-hidden="true"
                className={isCurrent ? "opacity-100" : "opacity-70"}
              />
              <TruncatedText hint={false}>{t(page)}</TruncatedText>
            </Button>
          </li>
        );
      })}
    </ul>
  );
};

/** Who this computer is linked as, and how that link is doing. A press
 *  opens General, where the account is. */
const SidebarIdentity = ({
  accountState,
  onOpen,
}: {
  accountState: DesktopAccountState;
  onOpen: () => void;
}) => {
  const t = useTranslations("settings");
  const display = accountDisplay(accountState);
  const tone = accountStatusTone(display.presentation.status);

  return (
    // No end padding: the status line gets the room to name the usual host
    // whole, and the avatar stays in line with the page icons below.
    <Button
      className="h-auto w-full min-w-0 justify-start gap-2 py-1.5 ps-2 pe-0 text-start font-normal"
      data-sidebar-account=""
      onClick={onOpen}
      variant="ghost"
    >
      <AccountAvatar display={display} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TruncatedText className="block text-sm font-semibold">
          {display.name ?? t("stellaDesktop")}
        </TruncatedText>
        {tone === null ? null : (
          // One row: a host too long for the sidebar is cut first, and the
          // status only when it alone does not fit. General shows the host
          // whole.
          <ListItemStatus
            className="flex w-full min-w-0"
            data-slot="sidebar-account-status"
            tone={tone}
          >
            <span className="flex min-w-0 flex-1 overflow-hidden">
              <TruncatedText className="shrink-0">
                {t(display.presentation.statusKey)}
              </TruncatedText>
              {display.presentation.host ? (
                <span className="flex min-w-0 overflow-hidden">
                  <span aria-hidden="true" className="shrink-0 whitespace-pre">
                    {" · "}
                  </span>
                  <TruncatedText
                    data-slot="sidebar-account-host"
                    render={<bdi dir="ltr" />}
                  >
                    {display.presentation.host}
                  </TruncatedText>
                </span>
              ) : null}
            </span>
          </ListItemStatus>
        )}
      </span>
    </Button>
  );
};
