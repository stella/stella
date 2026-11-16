import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { StellaMark } from "@stll/ui/components/stella-mark";
import { EllipsisIcon, LogOutIcon, RefreshCcwIcon } from "@stll/ui/icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

/**
 * The pane's top bar: the stella mark and name, and a quiet menu for the
 * two things people rarely need (reload the email, sign out).
 */
export const AppHeader = ({
  onRefresh,
  onSignOut,
}: {
  onRefresh?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}) => {
  const t = useTranslations("outlook");
  const hasMenu = onRefresh !== undefined || onSignOut !== undefined;

  return (
    <header className="bg-background/95 sticky top-0 z-10 flex h-11 items-center justify-between gap-3 px-3 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
        <StellaMark className="text-foreground size-4.5 shrink-0" />
        <span className="truncate text-sm font-medium">stella</span>
      </div>
      {hasMenu ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={t("moreActions")}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {onRefresh === undefined ? null : (
              <MenuItem onClick={onRefresh}>
                <RefreshCcwIcon />
                {t("refresh")}
              </MenuItem>
            )}
            {onSignOut === undefined ? null : (
              <MenuItem onClick={onSignOut}>
                <LogOutIcon />
                {t("signOut")}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      ) : null}
    </header>
  );
};
