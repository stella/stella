import { cn } from "@stll/ui/utils";

export const ClipboardSourceIcon = ({
  iconDataUrl,
  kind,
  size,
}: ClipboardSourceIconProps) => {
  const sizes = SOURCE_ICON_SIZES[size];
  if (kind === "app") {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={cn("clipboard-source-icon shrink-0", sizes.icon)}
        draggable={false}
        src={iconDataUrl}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "clipboard-source-icon clipboard-source-favicon grid shrink-0 place-items-center",
        sizes.tile,
      )}
    >
      <img
        alt=""
        className={sizes.tileIcon}
        draggable={false}
        src={iconDataUrl}
      />
    </span>
  );
};

const SOURCE_ICON_SIZES = {
  card: { icon: "size-7", tileIcon: "size-5", tile: "size-7 rounded-md" },
  inline: {
    icon: "size-4 rounded-[3px]",
    tileIcon: "size-3",
    tile: "size-4 rounded-[3px]",
  },
} as const;

type ClipboardSourceIconProps = {
  iconDataUrl: string;
  /** App icons carry their own shape; favicons get a browser-style tile. */
  kind: "app" | "favicon";
  size: keyof typeof SOURCE_ICON_SIZES;
};
