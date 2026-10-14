import { MonitorIcon } from "@stll/ui/icons";

import type { ClipboardSourceAppVisual } from "../clipboard/clipboard-types";
import { ClipboardSourceIcon } from "../clipboard/ClipboardSourceIcon";

export const ActivitySourceIcon = ({
  appIdentifier,
  sourceAppVisuals,
  size = "inline",
}: {
  appIdentifier: string;
  sourceAppVisuals: readonly ClipboardSourceAppVisual[];
  size?: "card" | "inline";
}) => {
  const iconDataUrl = sourceAppVisuals.find(
    ({ key }) => key === appIdentifier,
  )?.iconDataUrl;
  if (iconDataUrl) {
    return (
      <ClipboardSourceIcon iconDataUrl={iconDataUrl} kind="app" size={size} />
    );
  }
  return (
    <MonitorIcon
      aria-hidden="true"
      className={
        size === "card"
          ? "text-muted-foreground size-7 shrink-0"
          : "text-muted-foreground size-4 shrink-0"
      }
    />
  );
};
