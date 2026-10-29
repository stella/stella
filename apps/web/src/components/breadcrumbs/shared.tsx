import type { PropsWithChildren } from "react";

import { Link } from "@tanstack/react-router";

import { BreadcrumbItem } from "@stll/ui/breadcrumb";

import type { RouterToPath } from "@/lib/types";

/**
 * A crumb's switcher caret while more crumbs follow: hidden until the pointer
 * is over its crumb (the `group/crumb` item), so it never sits beside the
 * separator chevron at rest. Keyboard focus, an open popup and touch, which
 * has no hover, show it.
 */
export const CRUMB_SWITCHER_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity group-hover/crumb:opacity-100 group-focus-within/crumb:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100";

type BreadcrumbLinkProps = {
  to: RouterToPath;
  onClick?: () => void;
};

export const BreadcrumbLink = ({
  to,
  onClick,
  children,
}: PropsWithChildren<BreadcrumbLinkProps>) => (
  <BreadcrumbItem>
    <Link
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: "text-foreground font-semibold" }}
      className="hover:text-foreground max-w-64 truncate"
      onClick={onClick}
      to={to}
    >
      {children}
    </Link>
  </BreadcrumbItem>
);
