import type { TranslationKey } from "@/i18n/types";
import type { RouterToPath } from "@/lib/types";

export type RouteBreadcrumb =
  | {
      type: "label";
      labelKey: TranslationKey;
      to: RouterToPath;
    }
  | { type: "entity"; entity: "chat" | "contact" | "matter" | "pdf" }
  | {
      type: "knowledge-detail";
      detail: "clauses" | "playbooks" | "skill" | "templates";
    }
  | { type: "inherit" }
  | { type: "none" };

export type RoutePresentation = {
  breadcrumb: RouteBreadcrumb;
};

export const routePresentation = (
  breadcrumb: RouteBreadcrumb,
): RoutePresentation => ({ breadcrumb });
