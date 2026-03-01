import type { PropsWithChildren } from "react";
import { Link } from "@tanstack/react-router";

import { BreadcrumbItem } from "@stella/ui/components/breadcrumb";

import type { RouterToPath } from "@/lib/types";

type BreadcrumbLinkProps = {
  to: RouterToPath;
  onClick?: () => void;
};

export const BreadcrumbLink = ({
  to,
  onClick,
  children,
}: PropsWithChildren<BreadcrumbLinkProps>) => {
  return (
    <BreadcrumbItem>
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ className: "text-foreground font-semibold" }}
        className="max-w-64 truncate transition-colors hover:text-foreground"
        onClick={onClick}
        to={to}
      >
        {children}
      </Link>
    </BreadcrumbItem>
  );
};
