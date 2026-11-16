import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { browserSiteGrantHost } from "@stll/api-contract/browser-site-grants";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { GlobeIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupCount,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";

import {
  type BrowserSiteGrant,
  browserSiteGrantsOptions,
  deleteBrowserSiteGrant,
} from "@/features/chat/browser-control/browser-site-grants";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { useFormatter } from "@/i18n/formatting-context";
import { matchesConnectionQuery } from "@/lib/account/connections.logic";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

type BrowserSitesData = { visible: readonly BrowserSiteGrant[] };

/** The allowed websites matching the page's search, by host and origin. */
export const useBrowserSites = (query: string): BrowserSitesData => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const grantsView = queryView(
    useQuery(browserSiteGrantsOptions({ activeOrganizationId, userId })),
  );
  useQueryViewError(grantsView, "BrowserSitesGroup:query");
  const grants = grantsView.type === "items" ? grantsView.items.grants : [];
  return {
    visible: grants.filter((grant) =>
      matchesConnectionQuery(query, [
        browserSiteGrantHost(grant.origin),
        grant.origin,
      ]),
    ),
  };
};

/**
 * The websites where chat's browser actions run without asking, added from
 * a browser approval card. Hidden while none match: the card is where a
 * website is allowed, and this list is where it is taken back.
 */
export const BrowserSitesGroup = ({
  sites: { visible: grants },
}: {
  sites: BrowserSitesData;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (grants.length === 0) {
    return null;
  }

  return (
    <ListGroup aria-labelledby="connections-browser-sites">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="connections-browser-sites">
            {t("settings.connections.browserSitesTitle")}
            <ListGroupCount count={format.number(grants.length)} />
          </ListGroupTitle>
          <ListGroupDescription>
            {t("settings.connections.browserSitesDescription")}
          </ListGroupDescription>
        </ListGroupHeading>
      </ListGroupHeader>
      <List>
        {grants.map((grant) => (
          <BrowserSiteRow grant={grant} key={grant.id} />
        ))}
      </List>
    </ListGroup>
  );
};

const BrowserSiteRow = ({ grant }: { grant: BrowserSiteGrant }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const site = browserSiteGrantHost(grant.origin);
  const remove = useMutation({
    mutationFn: async () => await deleteBrowserSiteGrant(grant.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.browserSiteGrants(activeOrganizationId, userId),
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <ListItem>
      <ListItemMedia>
        <GlobeIcon />
      </ListItemMedia>
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{site}</BidiText>
        </ListItemTitle>
        <ListItemDescription>
          <bdi>{grant.origin}</bdi>
        </ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <Button
          aria-label={t("settings.connections.browserSiteRemove", { site })}
          loading={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
          size="xs"
          variant="outline"
        >
          {t("common.remove")}
        </Button>
      </ListItemActions>
    </ListItem>
  );
};
