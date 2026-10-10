import type { ComponentProps, ReactNode } from "react";

import { Button } from "./button";

type ToolbarIconActionProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size" | "title" | "tooltip" | "variant"
> & {
  /** Names the action for the tooltip and for assistive technology. */
  label: string;
  icon: ReactNode;
  /** `header` for the app header row, `toolbar` for a viewer's toolbar. */
  density: "header" | "toolbar";
};

const SIZE_BY_DENSITY = {
  header: "icon-sm",
  toolbar: "icon-xs",
} as const satisfies Record<
  ToolbarIconActionProps["density"],
  ComponentProps<typeof Button>["size"]
>;

/**
 * One action in a toolbar row of icons. It has no children, so a row cannot
 * mix a labelled text button in among its icons: the label is the tooltip
 * and the accessible name, and the row stays the same shape everywhere.
 */
export const ToolbarIconAction = ({
  density,
  icon,
  label,
  ...props
}: ToolbarIconActionProps) => (
  <Button
    {...props}
    aria-label={label}
    size={SIZE_BY_DENSITY[density]}
    // The tooltip names the action; a native title would show a second one.
    title={undefined}
    tooltip={label}
    variant="ghost"
  >
    {icon}
  </Button>
);
