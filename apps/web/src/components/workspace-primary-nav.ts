import type { ComponentType } from "react";

import {
  BlocksIcon,
  InboxIcon,
  LibraryBigIcon,
  MessageSquareIcon,
  BookOpenIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";

import { MattersNavIcon } from "@/components/matter-icon";
import type { TranslationKey } from "@/i18n/types";

type WorkspacePrimaryRoute =
  | "/chat"
  | "/contacts"
  | "/inbox"
  | "/knowledge"
  | "/law"
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
    icon: BookOpenIcon,
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

export type WorkspacePrimaryNavId =
  (typeof WORKSPACE_PRIMARY_NAV_ITEMS)[number]["id"];

export const getWorkspacePrimaryNavItems = ({
  includeInbox,
  includePublicLaw,
  includePublicTools,
}: {
  includeInbox: boolean;
  includePublicLaw: boolean;
  includePublicTools: boolean;
}) =>
  WORKSPACE_PRIMARY_NAV_ITEMS.filter((item) => {
    if (item.id === "caseLaw") {
      return includePublicLaw;
    }
    if (item.id === "inbox") {
      return includeInbox;
    }
    if (item.id === "tools") {
      return includePublicTools;
    }
    return true;
  });
