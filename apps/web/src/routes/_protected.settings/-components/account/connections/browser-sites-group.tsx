import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { browserSiteGrantHost } from "@stll/api-contract/browser-site-grants";
import type { BrowserSiteNoteKind } from "@stll/api-contract/browser-site-notes";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { GlobeIcon, StickyNoteIcon, XIcon } from "@stll/ui/icons";
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
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import {
  type BrowserSiteGrant,
  browserSiteGrantsOptions,
  deleteBrowserSiteGrant,
} from "@/features/chat/browser-control/browser-site-grants";
import {
  type BrowserSiteNote,
  browserSiteNotesOptions,
  deleteBrowserSiteNote,
  deleteBrowserSiteNotesForSite,
} from "@/features/chat/browser-control/browser-site-notes";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { matchesConnectionQuery } from "@/lib/account/connections.logic";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * One website chat's browser works on for the member: its standing approval,
 * when they gave one, and the research notes the agent keeps about how it
 * works. Either may exist without the other.
 */
type BrowserSite = {
  origin: string;
  grant: BrowserSiteGrant | null;
  notes: readonly BrowserSiteNote[];
};

type BrowserSitesData = { visible: readonly BrowserSite[] };

/** The websites matching the page's search, by host and origin. */
export const useBrowserSites = (query: string): BrowserSitesData => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const grantsView = queryView(
    useQuery(browserSiteGrantsOptions({ activeOrganizationId, userId })),
  );
  const notesView = queryView(
    useQuery(browserSiteNotesOptions({ activeOrganizationId, userId })),
  );
  useQueryViewError(grantsView, "BrowserSitesGroup:query");
  useQueryViewError(notesView, "BrowserSitesGroup:notes-query");
  const grants = grantsView.type === "items" ? grantsView.items.grants : [];
  const noted = notesView.type === "items" ? notesView.items.sites : [];
  const sites = new Map<string, BrowserSite>();
  for (const grant of grants) {
    sites.set(grant.origin, { origin: grant.origin, grant, notes: [] });
  }
  for (const site of noted) {
    sites.set(site.origin, {
      origin: site.origin,
      grant: sites.get(site.origin)?.grant ?? null,
      notes: site.notes,
    });
  }
  return {
    visible: [...sites.values()]
      .toSorted((a, b) => (a.origin < b.origin ? -1 : 1))
      .filter((site) =>
        matchesConnectionQuery(query, [
          browserSiteGrantHost(site.origin),
          site.origin,
        ]),
      ),
  };
};

/**
 * The websites chat's browser works on: where its actions run without
 * asking (added from a browser approval card), and where the agent keeps
 * research notes. Hidden while none match: this list is where an approval is
 * taken back and notes are reviewed and removed.
 */
export const BrowserSitesGroup = ({
  sites: { visible: sites },
}: {
  sites: BrowserSitesData;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (sites.length === 0) {
    return null;
  }

  return (
    <ListGroup aria-labelledby="connections-browser-sites">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="connections-browser-sites">
            {t("settings.connections.browserSitesTitle")}
            <ListGroupCount count={format.number(sites.length)} />
          </ListGroupTitle>
          <ListGroupDescription>
            {t("settings.connections.browserSitesDescription")}
          </ListGroupDescription>
        </ListGroupHeading>
      </ListGroupHeader>
      <List>
        {sites.map((site) => (
          <BrowserSiteRows key={site.origin} site={site} />
        ))}
      </List>
    </ListGroup>
  );
};

const NOTE_KIND_LABEL_KEYS = {
  works: "settings.connections.browserSiteNoteKinds.works",
  failed: "settings.connections.browserSiteNoteKinds.failed",
  fixed: "settings.connections.browserSiteNoteKinds.fixed",
} as const satisfies Record<BrowserSiteNoteKind, TranslationKey>;

const NOTE_KIND_TONES = {
  works: "success",
  failed: "warning",
  fixed: "neutral",
} as const satisfies Record<
  BrowserSiteNoteKind,
  "success" | "warning" | "neutral"
>;

const useRefreshBrowserSites = () => {
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: chatKeys.browserSiteGrants(activeOrganizationId, userId),
      }),
      queryClient.invalidateQueries({
        queryKey: chatKeys.browserSiteNotes(activeOrganizationId, userId),
      }),
    ]);
  };
};

const BrowserSiteRows = ({ site }: { site: BrowserSite }) => {
  const t = useTranslations();
  const format = useFormatter();
  const refresh = useRefreshBrowserSites();
  const [notesOpen, setNotesOpen] = useState(false);
  const host = browserSiteGrantHost(site.origin);
  const remove = useMutation({
    mutationFn: async (what: "approval" | "notes" | "both") => {
      if (what !== "notes" && site.grant !== null) {
        await deleteBrowserSiteGrant(site.grant.id);
      }
      if (what !== "approval") {
        await deleteBrowserSiteNotesForSite(site.origin);
      }
    },
    onSettled: refresh,
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const hasNotes = site.notes.length > 0;

  return (
    <>
      <ListItem>
        <ListItemMedia>
          <GlobeIcon />
        </ListItemMedia>
        <ListItemContent>
          <ListItemTitle>
            <BidiText>{host}</BidiText>
          </ListItemTitle>
          <ListItemDescription>
            <bdi>{site.origin}</bdi>
          </ListItemDescription>
        </ListItemContent>
        <ListItemActions>
          {site.grant !== null && (
            <ListItemStatus tone="success">
              {t("settings.connections.browserSiteAllowed")}
            </ListItemStatus>
          )}
          {hasNotes && (
            <Button
              aria-expanded={notesOpen}
              onClick={() => {
                setNotesOpen((open) => !open);
              }}
              size="xs"
              variant="ghost"
            >
              {t("settings.connections.browserSiteNotesCount", {
                count: format.number(site.notes.length),
              })}
            </Button>
          )}
          {site.grant !== null && hasNotes ? (
            <Menu>
              <MenuTrigger
                aria-label={t("settings.connections.browserSiteRemove", {
                  site: host,
                })}
                render={
                  <Button
                    loading={remove.isPending}
                    size="xs"
                    variant="outline"
                  />
                }
              >
                {t("common.remove")}
              </MenuTrigger>
              <MenuPopup>
                <MenuItem
                  onClick={() => {
                    remove.mutate("approval");
                  }}
                >
                  {t("settings.connections.browserSiteRemoveApproval")}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    remove.mutate("notes");
                  }}
                >
                  {t("settings.connections.browserSiteDeleteNotes")}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    remove.mutate("both");
                  }}
                >
                  {t("settings.connections.browserSiteRemoveApprovalAndNotes")}
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : (
            <Button
              aria-label={t(
                site.grant === null
                  ? "settings.connections.browserSiteDeleteNotesFor"
                  : "settings.connections.browserSiteRemove",
                { site: host },
              )}
              loading={remove.isPending}
              onClick={() => {
                remove.mutate(site.grant === null ? "notes" : "approval");
              }}
              size="xs"
              variant="outline"
            >
              {t("common.remove")}
            </Button>
          )}
        </ListItemActions>
      </ListItem>
      {/* The notes follow their website's row in the same list, so they
          keep its row anatomy; closed, they leave the page. */}
      {hasNotes &&
        notesOpen &&
        site.notes.map((note) => (
          <BrowserSiteNoteRow host={host} key={note.id} note={note} />
        ))}
    </>
  );
};

const BrowserSiteNoteRow = ({
  host,
  note,
}: {
  host: string;
  note: BrowserSiteNote;
}) => {
  const t = useTranslations();
  const refresh = useRefreshBrowserSites();
  const remove = useMutation({
    mutationFn: async () => await deleteBrowserSiteNote(note.id),
    onSettled: refresh,
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (
    <ListItem>
      <ListItemMedia>
        <StickyNoteIcon />
      </ListItemMedia>
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{note.step}</BidiText>
        </ListItemTitle>
        <ListItemDescription variant="paragraph">
          <BidiText>{note.text}</BidiText>
        </ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <ListItemStatus tone={NOTE_KIND_TONES[note.kind]}>
          {t(NOTE_KIND_LABEL_KEYS[note.kind])}
        </ListItemStatus>
        <Button
          aria-label={t("settings.connections.browserSiteDeleteNote", {
            step: `${host}: ${note.step}`,
          })}
          loading={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </ListItemActions>
    </ListItem>
  );
};
