import { cloneElement } from "react";
import type { ReactElement, ReactNode } from "react";

type TooltipProps = {
  content: ReactNode;
  children: ReactElement<TooltipChildProps>;
  side?: "top" | "bottom" | "left" | "right";
  delayMs?: number;
};

type TooltipChildProps = {
  "aria-label"?: string | undefined;
  title?: string | undefined;
};

export function Tooltip({ content, children }: TooltipProps) {
  const label = getTooltipLabel(content);
  if (!label) {
    return children;
  }

  return cloneElement(children, {
    "aria-label": children.props["aria-label"] ?? label,
    title: children.props.title ?? label,
  });
}

function getTooltipLabel(content: ReactNode): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "number") {
    return content.toString();
  }

  return undefined;
}
