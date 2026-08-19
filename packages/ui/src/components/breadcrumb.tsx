"use client";

import type * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "../lib/utils";
import { DirectionalIcon } from "./directional-icon";

const Breadcrumb = ({ ...props }: React.ComponentProps<"nav">) => (
  <nav aria-label="Breadcrumb" data-slot="breadcrumb" {...props} />
);

const BreadcrumbList = ({
  className,
  ...props
}: React.ComponentProps<"ol">) => (
  <ol
    className={cn(
      "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm wrap-break-word sm:gap-2.5",
      className,
    )}
    data-slot="breadcrumb-list"
    {...props}
  />
);

const BreadcrumbItem = ({
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    className={cn("inline-flex items-center gap-1.5", className)}
    data-slot="breadcrumb-item"
    {...props}
  />
);

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  const defaultProps = {
    className: cn("hover:text-foreground transition-colors", className),
    "data-slot": "breadcrumb-link",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

const BreadcrumbPage = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    aria-current="page"
    className={cn("text-foreground font-normal", className)}
    data-slot="breadcrumb-page"
    {...props}
  />
);

const BreadcrumbSeparator = ({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    aria-hidden="true"
    className={cn("opacity-80 [&>svg]:size-4", className)}
    data-slot="breadcrumb-separator"
    role="presentation"
    {...props}
  >
    {children ?? <DirectionalIcon icon={ChevronRight} />}
  </li>
);

const BreadcrumbEllipsis = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    aria-hidden="true"
    className={className}
    data-slot="breadcrumb-ellipsis"
    role="presentation"
    {...props}
  >
    <MoreHorizontal className="size-4" />
    <span className="sr-only">More</span>
  </span>
);

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
