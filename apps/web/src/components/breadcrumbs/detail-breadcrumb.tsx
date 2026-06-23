import {
  BreadcrumbItem,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";

import type { OpenDetail } from "@/components/breadcrumbs/detail-nav-store";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import type { RouterToPath } from "@/lib/types";

type DetailBreadcrumbProps = {
  /** Where the list crumb points, and the callback wired to it once open. */
  to: RouterToPath;
  label: string;
  /** The open item published by the detail view, or null on the list. */
  open: OpenDetail | null;
};

/**
 * "<label>" always names the list. When an item is open in a view-state detail
 * — not an `$id` route — append "› <name>" and turn "<label>" into a button
 * that exits to the list. The open item + name + exit callback live in the nav
 * store the detail view publishes; each section wires its own store and label.
 */
export const DetailBreadcrumb = ({
  to,
  label,
  open,
}: DetailBreadcrumbProps) => {
  if (!open) {
    return <BreadcrumbLink to={to}>{label}</BreadcrumbLink>;
  }

  return (
    <>
      <BreadcrumbItem>
        <button
          className="hover:text-foreground transition-colors"
          onClick={open.exit}
          type="button"
        >
          {label}
        </button>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
      <BreadcrumbItem
        className="text-foreground max-w-64 truncate font-semibold"
        dir="auto"
      >
        {open.name}
      </BreadcrumbItem>
    </>
  );
};
