import { useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { apiUrl } from "@/lib/api-url";

// The API renders the ThumbHash blur as a PNG data URL. Anything else is not
// placed into a CSS `url()`.
const PLACEHOLDER_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u;

const placeholderStyle = (
  placeholder: string | null | undefined,
): CSSProperties | undefined =>
  placeholder && PLACEHOLDER_PATTERN.test(placeholder)
    ? {
        backgroundImage: `url("${placeholder}")`,
        backgroundPosition: "center",
        backgroundSize: "cover",
      }
    : undefined;

/** Where a matter file field's generated preview image is served. */
const matterFileThumbnailUrl = (workspaceId: string, fieldId: string) =>
  apiUrl(
    `/files/${encodeURIComponent(workspaceId)}/thumbnail/${encodeURIComponent(fieldId)}`,
  );

/** Which matter file field's thumbnail to show, and whether it has one. */
export type MatterFileThumbnailRef = {
  fieldId: string;
  /** The file has a generated preview image. Without one, nothing is
   *  requested and the type icon shows. */
  hasThumbnail: boolean;
  workspaceId: string;
};

/**
 * The thumbnail source for a file, or null when it has none or it failed to
 * load. Failure is keyed by the source so a row that starts pointing at
 * another file tries its thumbnail again instead of inheriting the previous
 * failure.
 */
const useThumbnailSource = ({
  fieldId,
  hasThumbnail,
  workspaceId,
}: MatterFileThumbnailRef) => {
  const src = hasThumbnail
    ? matterFileThumbnailUrl(workspaceId, fieldId)
    : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return {
    src: src !== null && failedSrc !== src ? src : null,
    onError: () => setFailedSrc(src),
  };
};

type FileThumbnailProps = MatterFileThumbnailRef & {
  /** The file name; the image's accessible name. */
  alt: string;
  className?: string;
  /** Shown when the file has no thumbnail or the thumbnail fails to load. */
  fallbackIcon: ReactNode;
  /** ThumbHash `data:image/png;base64,...` blur shown until the image paints. */
  placeholder?: string | null;
};

/**
 * A matter file's preview image in a fixed square box: the blur placeholder
 * paints at once behind the image, so the box never changes size or shifts
 * the layout while the thumbnail loads. Without a thumbnail, or when it fails
 * to load, the box shows the file's icon instead.
 */
export const FileThumbnail = ({
  alt,
  className,
  fallbackIcon,
  fieldId,
  hasThumbnail,
  placeholder,
  workspaceId,
}: FileThumbnailProps) => {
  const { src, onError } = useThumbnailSource({
    fieldId,
    hasThumbnail,
    workspaceId,
  });

  return (
    <span
      className={cn(
        "bg-muted relative block aspect-square shrink-0 overflow-hidden rounded-md",
        "outline-foreground/8 outline-1 -outline-offset-1",
        className,
      )}
      style={src === null ? undefined : placeholderStyle(placeholder)}
    >
      {src === null ? (
        <span
          aria-label={alt}
          className="text-muted-foreground flex size-full items-center justify-center"
          role="img"
        >
          {fallbackIcon}
        </span>
      ) : (
        <img
          alt={alt}
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          onError={onError}
          src={src}
        />
      )}
    </span>
  );
};

type FileThumbnailIconProps = MatterFileThumbnailRef & {
  /** The type icon's own size classes (e.g. `size-4 shrink-0`), so the image
   *  takes exactly the box the icon would. */
  className?: string | undefined;
  /** The file-type icon, drawn as-is without a thumbnail or when it fails. */
  fallbackIcon: ReactElement;
};

/**
 * A file's thumbnail at icon size, in the type icon's slot. It sits next to
 * the file name, so it is decorative (empty alt) and the row keeps its
 * accessible name. At this size a blur placeholder reads as noise, so the box
 * is a flat muted square until the image paints.
 */
export const FileThumbnailIcon = ({
  className,
  fallbackIcon,
  fieldId,
  hasThumbnail,
  workspaceId,
}: FileThumbnailIconProps) => {
  const { src, onError } = useThumbnailSource({
    fieldId,
    hasThumbnail,
    workspaceId,
  });
  if (src === null) {
    return fallbackIcon;
  }
  return (
    <img
      alt=""
      className={cn(
        "bg-muted aspect-square rounded-sm object-cover",
        "outline-foreground/8 outline-1 -outline-offset-1",
        className,
      )}
      decoding="async"
      loading="lazy"
      onError={onError}
      src={src}
    />
  );
};
