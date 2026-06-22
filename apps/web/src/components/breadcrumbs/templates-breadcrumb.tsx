import { useTranslations } from "use-intl";

import {
  BreadcrumbItem,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { useTemplateNavStore } from "@/routes/_protected.knowledge/-components/template-nav-store";

/**
 * "Templates" always points at the list. When a template is open in the Studio
 * — a view-state, not a `$templateId` route — append "› <name>" and turn
 * "Templates" into a button that exits to the list. The open template + its
 * name + the exit callback live in the nav store the detail view publishes.
 */
export const TemplatesBreadcrumb = () => {
  const t = useTranslations();
  const open = useTemplateNavStore((s) => s.open);

  if (!open) {
    return (
      <BreadcrumbLink to="/knowledge/templates">
        {t("navigation.templates")}
      </BreadcrumbLink>
    );
  }

  return (
    <>
      <BreadcrumbItem>
        <button
          className="hover:text-foreground transition-colors"
          onClick={open.exit}
          type="button"
        >
          {t("navigation.templates")}
        </button>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
      <BreadcrumbItem className="text-foreground max-w-64 truncate font-semibold">
        {open.name}
      </BreadcrumbItem>
    </>
  );
};
