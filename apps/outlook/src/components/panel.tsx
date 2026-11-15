import type { PropsWithChildren, ReactNode } from "react";

import {
  ListGroup,
  ListGroupAction,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
} from "@stll/ui/list";

import type { translator } from "@/i18n";

export type Translate = typeof translator;

/**
 * A titled section of the task pane: the design system's grouped-list header
 * (title, optional count, optional trailing action) over the
 * section's content.
 */
export const Panel = ({
  action,
  children,
  className,
  title,
}: PropsWithChildren<{
  action?: ReactNode;
  className?: string;
  title: ReactNode;
}>) => (
  <ListGroup className={className}>
    <ListGroupHeader className="items-center">
      <ListGroupHeading>
        <ListGroupTitle>{title}</ListGroupTitle>
      </ListGroupHeading>
      {action === undefined ? null : (
        <ListGroupAction>{action}</ListGroupAction>
      )}
    </ListGroupHeader>
    {children}
  </ListGroup>
);
