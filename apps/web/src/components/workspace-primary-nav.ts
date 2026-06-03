import type { LucideIcon } from "lucide-react";
import {
  BookOpenIcon,
  LayersIcon,
  MessageSquareIcon,
  ScaleIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

type WorkspacePrimaryRoute =
  | "/chat"
  | "/contacts"
  | "/knowledge"
  | "/law/cases"
  | "/workspaces";

type WorkspacePrimaryNavItem = {
  readonly icon: LucideIcon;
  readonly id:
    | "caseLaw"
    | "chat"
    | "contacts"
    | "knowledge"
    | "matters"
    | "search";
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
    icon: LayersIcon,
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
