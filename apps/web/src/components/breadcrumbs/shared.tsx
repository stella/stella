import type { PropsWithChildren } from "react";

import { Link } from "@tanstack/react-router";

import { BreadcrumbItem } from "@stll/ui/components/breadcrumb";

import type { RouterToPath } from "@/lib/types";

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
      className="hover:text-foreground max-w-64 truncate transition-colors"
      onClick={onClick}
      to={to}
    >
      {children}
    </Link>
  </BreadcrumbItem>
);
