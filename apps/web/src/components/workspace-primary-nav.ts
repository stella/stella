import type { ComponentType } from "react";

import {
  BlocksIcon,
  BookOpenIcon,
  MessageSquareIcon,
  ScaleIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";

import { MattersNavIcon } from "@/components/matter-icon";
import type { TranslationKey } from "@/i18n/types";

type WorkspacePrimaryRoute =
  | "/chat"
  | "/contacts"
  | "/knowledge"
  | "/law/cases"
  | "/tools"
  | "/workspaces";

type WorkspacePrimaryNavItem = {
  readonly icon: ComponentType<{ className?: string }>;
  readonly id:
    | "caseLaw"
    | "chat"
    | "contacts"
    | "knowledge"
    | "matters"
    | "search"
    | "tools";
  readonly labelKey: TranslationKey;
} & (
  | {
      readonly kind: "action";
    }
  | {
      readonly kind: "route";
      readonly to: WorkspacePrimaryRoute;
    }
);

export const WORKSPACE_PRIMARY_NAV_ITEMS = [
  {
    icon: SearchIcon,
    id: "search",
    kind: "action",
    labelKey: "navigation.search",
  },
  {
    icon: MessageSquareIcon,
    id: "chat",
    kind: "route",
    labelKey: "navigation.chat",
    to: "/chat",
  },
  {
    icon: MattersNavIcon,
    id: "matters",
    kind: "route",
    labelKey: "common.matters",
    to: "/workspaces",
  },
  {
    icon: ScaleIcon,
    id: "caseLaw",
    kind: "route",
    labelKey: "common.caseLaw",
    to: "/law/cases",
  },
  {
    icon: BlocksIcon,
    id: "tools",
    kind: "route",
    // Reuse the canonical "Tools" label; no per-surface variant.
    labelKey: "knowledge.sections.tools.title",
    to: "/tools",
  },
  {
    icon: BookOpenIcon,
    id: "knowledge",
    kind: "route",
    labelKey: "navigation.knowledge",
    to: "/knowledge",
  },
  {
    icon: UsersIcon,
    id: "contacts",
    kind: "route",
    labelKey: "navigation.contacts",
    to: "/contacts",
  },
] as const satisfies readonly WorkspacePrimaryNavItem[];

export type WorkspacePrimaryNavId =
  (typeof WORKSPACE_PRIMARY_NAV_ITEMS)[number]["id"];

export const getWorkspacePrimaryNavItems = ({
  includePublicLaw,
  includePublicTools,
}: {
  includePublicLaw: boolean;
  includePublicTools: boolean;
}) =>
  WORKSPACE_PRIMARY_NAV_ITEMS.filter((item) => {
    if (item.id === "caseLaw") {
      return includePublicLaw;
    }
    if (item.id === "tools") {
      return includePublicTools;
    }
    return true;
  });
