import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { buttonVariants } from "@stll/ui/button";
import { ExternalLinkIcon, GlobeIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";
import { cn } from "@stll/ui/utils";

import { useBrowserExtensionStoreUrl } from "@/features/chat/browser-control/use-browser-extension-store-url";

/** The store listing row; absent where the released extension never connects. */
export const BrowserExtensionGroup = () => {
  const t = useTranslations();
  const storeUrl = useBrowserExtensionStoreUrl();
  if (storeUrl === null) {
    return null;
  }

  return (
    <ListGroup aria-label={t("settings.connections.browserExtensionTitle")}>
      <List>
        <ListItem>
          <ListItemMedia>
            <GlobeIcon />
          </ListItemMedia>
          <ListItemContent>
            <ListItemTitle>
              {t("settings.connections.browserExtensionTitle")}
            </ListItemTitle>
            <ListItemDescription>
              {t("settings.connections.browserExtensionDescription")}
            </ListItemDescription>
          </ListItemContent>
          <ListItemActions>
            <a
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              href={sanitizeHref(storeUrl)}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon />
              {t("settings.connections.browserExtensionInstall")}
            </a>
          </ListItemActions>
        </ListItem>
      </List>
    </ListGroup>
  );
};
