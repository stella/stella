import type { ReactNode } from "react";

import { InputFace } from "@stll/ui/control-face";
import { SearchIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItemSkeleton,
} from "@stll/ui/list-shell";

import { AssistantSetupPending } from "@/components/assistant-setup.pending";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The connections page's one layout, drawn by both phases: the heading and
 * the search field, then the groups. The page fills the search slot with
 * the live field and the groups with the live lists; the pending phase with
 * the field's face, the assistant setup in its pending phase and each
 * group's real heading over placeholder rows, in the page's order.
 */

type ConnectionsPageShellProps = {
  /** The search field. */
  search: ReactNode;
  /** The groups, or what stands in for them. */
  children: ReactNode;
};

/** The connections page's layout, in both phases. */
export const ConnectionsPageShell = ({
  children,
  search,
}: ConnectionsPageShellProps) => (
  <div className="flex flex-col gap-8">
    <div className="flex flex-col gap-4">
      <SettingsPageHeaderPending
        description="settings.connections.description"
        title="settings.connections.title"
      />
      {search}
    </div>
    {children}
  </div>
);

type ConnectionsGroupPendingProps = {
  title: PendingTextKey;
  description: PendingTextKey;
  /** How many placeholder rows (at most three), about what a member has. */
  rows: 1 | 2 | 3;
};

const ROW_KEYS = [{ key: "a" }, { key: "b" }, { key: "c" }] as const;

/** A group while its rows load: the real heading over row placeholders. */
const ConnectionsGroupPending = ({
  description,
  rows,
  title,
}: ConnectionsGroupPendingProps) => (
  <ListGroup>
    <ListGroupHeader>
      <ListGroupHeading>
        <ListGroupTitle>
          <PendingText barClassName="w-28" id={title} />
        </ListGroupTitle>
        <ListGroupDescription>
          <PendingText barClassName="w-72 max-w-full" id={description} />
        </ListGroupDescription>
      </ListGroupHeading>
    </ListGroupHeader>
    <List aria-hidden="true">
      {ROW_KEYS.slice(0, rows).map(({ key }, index) => (
        <ListItemSkeleton index={index} key={key} media trailing="text" />
      ))}
    </List>
  </ListGroup>
);

/**
 * The groups in the page's order, by heading. Groups that show only when
 * something is there (SharePoint, browser sites, the browser extension's
 * store row) wait for the data rather than reserving space they may not
 * take.
 */
const CONNECTION_GROUPS_PENDING = [
  {
    key: "integrations",
    title: "settings.connections.integrationsTitle",
    description: "settings.connections.integrationsDescription",
    rows: 3,
  },
  {
    key: "apps",
    title: "settings.connections.connectedAppsTitle",
    description: "settings.connections.connectedAppsDescription",
    rows: 2,
  },
  {
    key: "mcp",
    title: "settings.connections.mcpTitle",
    description: "settings.connections.mcpSetupHint",
    rows: 2,
  },
  {
    key: "cli",
    title: "settings.connections.cliTitle",
    description: "settings.connections.cliDescription",
    rows: 1,
  },
] as const satisfies readonly (ConnectionsGroupPendingProps & {
  key: string;
})[];

const ConnectionsPendingView = () => (
  <SettingsPagePending area="account">
    <ConnectionsPageShell
      search={
        <InputFace icon={<SearchIcon />}>
          <PendingText
            barClassName="w-32"
            id="settings.connections.searchPlaceholder"
          />
        </InputFace>
      }
    >
      <AssistantSetupPending />
      {CONNECTION_GROUPS_PENDING.map(({ key, ...group }) => (
        <ConnectionsGroupPending key={key} {...group} />
      ))}
    </ConnectionsPageShell>
  </SettingsPagePending>
);

export const ConnectionsPending = framePendingView(ConnectionsPendingView);
