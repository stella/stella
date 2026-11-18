import { useTranslations } from "use-intl";

import { Avatar, AvatarFallback } from "@stll/ui/avatar";
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
import { StellaMark } from "@stll/ui/stella-mark";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { accountDisplay, accountStatusTone } from "./account-presentation";
import type { DesktopAccountState } from "./account-presentation";
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
      <SidebarIdentity accountState={accountState} />
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

/** Who this computer is linked as, and how that link is doing. */
const SidebarIdentity = ({
  accountState,
}: {
  accountState: DesktopAccountState;
}) => {
  const t = useTranslations("settings");
  const display = accountDisplay(accountState);
  const tone = accountStatusTone(display.presentation.status);

  return (
    <div className="flex min-w-0 items-center gap-2.5 px-2 py-1.5">
      <Avatar className="size-8 border">
        <AvatarFallback className="text-xs">
          {display.initials ?? <StellaMark className="size-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TruncatedText className="text-sm font-semibold" render={<p />}>
          {display.name ?? t("stellaDesktop")}
        </TruncatedText>
        {tone === null ? null : (
          // A long host wraps to a second line and is cut there, so the
          // pages below keep their room; General shows it whole.
          <ListItemStatus className="min-w-0 whitespace-normal" tone={tone}>
            <TruncatedText lines={2}>
              {t(display.presentation.statusKey)}
              {display.presentation.host ? (
                <>
                  {" · "}
                  <bdi dir="ltr">{display.presentation.host}</bdi>
                </>
              ) : null}
            </TruncatedText>
          </ListItemStatus>
        )}
      </div>
    </div>
  );
};
