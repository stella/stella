import type { ComponentType } from "react";

import {
  BlocksIcon,
  InboxIcon,
  LibraryBigIcon,
  MessageSquareIcon,
  CaseLawIcon,
  Clock3Icon,
  SearchIcon,
  UsersIcon,
} from "@stll/ui/icons";
import { MattersNavIcon } from "@stll/ui/matter-icon";

import type { TranslationKey } from "@/i18n/types";

type WorkspacePrimaryRoute =
  | "/chat"
  | "/contacts"
  | "/inbox"
  | "/knowledge"
  | "/law"
  | "/time"
  | "/tools"
  | "/workspaces";

type WorkspacePrimaryNavItem = {
  readonly icon: ComponentType<{ className?: string }>;
  readonly id: string;
  readonly labelKey: TranslationKey;
} & (
  | {
      readonly audience: "authenticated";
      readonly kind: "action";
    }
  | {
      readonly audience: "authenticated" | "public";
      readonly kind: "route";
      readonly to: WorkspacePrimaryRoute;
    }
);

export const WORKSPACE_PRIMARY_NAV_ITEMS = [
  {
    icon: SearchIcon,
    id: "search",
    audience: "authenticated",
    kind: "action",
    labelKey: "navigation.search",
  },
  {
    icon: MessageSquareIcon,
    id: "chat",
    audience: "authenticated",
    kind: "route",
    labelKey: "navigation.chat",
    to: "/chat",
  },
  {
    icon: InboxIcon,
    id: "inbox",
    audience: "authenticated",
    kind: "route",
    labelKey: "navigation.inbox",
    to: "/inbox",
  },
  {
    icon: MattersNavIcon,
    id: "matters",
    audience: "authenticated",
    kind: "route",
    labelKey: "common.matters",
    to: "/workspaces",
  },
  {
    icon: Clock3Icon,
    id: "timesheets",
    audience: "authenticated",
    kind: "route",
    labelKey: "billing.timesheets",
    to: "/time",
  },
  {
    icon: CaseLawIcon,
    id: "caseLaw",
    audience: "public",
    kind: "route",
    labelKey: "common.caseLaw",
    to: "/law",
  },
  {
    icon: BlocksIcon,
    id: "tools",
    audience: "public",
    kind: "route",
    // Reuse the canonical "Tools" label; no per-surface variant.
    labelKey: "knowledge.sections.tools.title",
    // The older top-level tools pages; this entry goes with them once the
    // Knowledge flag is permanent.
    to: "/tools",
  },
  {
    icon: LibraryBigIcon,
    id: "knowledge",
    audience: "authenticated",
    kind: "route",
    labelKey: "navigation.knowledge",
    to: "/knowledge",
  },
  {
    icon: UsersIcon,
    id: "contacts",
    audience: "authenticated",
    kind: "route",
    labelKey: "navigation.contacts",
    to: "/contacts",
  },
] as const satisfies readonly WorkspacePrimaryNavItem[];

/** Knowledge as an entry anyone can open, tools included. */
const PUBLIC_KNOWLEDGE_NAV_ITEM = {
  icon: LibraryBigIcon,
  id: "knowledge",
  audience: "public",
  kind: "route",
  labelKey: "navigation.knowledge",
  to: "/knowledge",
} as const satisfies WorkspacePrimaryNavItem;

export type WorkspacePrimaryNavId =
  (typeof WORKSPACE_PRIMARY_NAV_ITEMS)[number]["id"];

type WorkspacePrimaryNavEntry =
  | (typeof WORKSPACE_PRIMARY_NAV_ITEMS)[number]
  | typeof PUBLIC_KNOWLEDGE_NAV_ITEM;

export const getWorkspacePrimaryNavItems = ({
  includeInbox,
  includePublicLaw,
  includePublicTools,
  includeTimesheets,
  publicKnowledge,
}: {
  includeInbox: boolean;
  includePublicLaw: boolean;
  includePublicTools: boolean;
  includeTimesheets: boolean;
  /** Knowledge is readable without an account, and holds the tools. */
  publicKnowledge: boolean;
}) =>
  WORKSPACE_PRIMARY_NAV_ITEMS.flatMap((item): WorkspacePrimaryNavEntry[] => {
    if (item.id === "caseLaw") {
      return includePublicLaw ? [item] : [];
    }
    if (item.id === "inbox") {
      return includeInbox ? [item] : [];
    }
    if (item.id === "tools") {
      return includePublicTools && !publicKnowledge ? [item] : [];
    }
    if (item.id === "timesheets") {
      return includeTimesheets ? [item] : [];
    }
    if (item.id === "knowledge" && publicKnowledge) {
      return [PUBLIC_KNOWLEDGE_NAV_ITEM];
    }
    return [item];
  });
