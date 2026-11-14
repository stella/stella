import { useState } from "react";
import type { ComponentProps } from "react";

import { useQuery } from "@tanstack/react-query";

import { exactIconOptions } from "@/features/chat/link-icons";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { queryView } from "@/lib/query-view.logic";

type ProxiedIconProps = Omit<ComponentProps<"img">, "alt" | "src"> & {
  alt: string;
  remoteUrl: string | null | undefined;
};

export const ProxiedIcon = ({ alt, remoteUrl, ...props }: ProxiedIconProps) => {
  const src = useProxiedIconSrc(remoteUrl);
  return src ? <img {...props} alt={alt} src={src} /> : null;
};

/** Resolves an untrusted remote icon through the authenticated API. */
export const useProxiedIconSrc = (
  remoteUrl: string | null | undefined,
): string | undefined => {
  const iconUrl = remoteUrl ? safeIconUrl(remoteUrl) : undefined;
  const iconQuery = useQuery({
    ...exactIconOptions(iconUrl ?? ""),
    enabled: iconUrl !== undefined,
  });
  const iconView = queryView(iconQuery);
  const icon = iconView.type === "items" ? iconView.items : undefined;
  const blob = icon?.type === "icon" ? icon.blob : undefined;
  const [localIcon, setLocalIcon] = useState<{
    blob: Blob;
    src: string;
  } | null>(null);

  useExternalSyncEffect(() => {
    if (!blob) {
      setLocalIcon(null);
      return undefined;
    }
    const src = URL.createObjectURL(blob);
    setLocalIcon({ blob, src });
    return () => URL.revokeObjectURL(src);
  }, [blob]);

  return localIcon && localIcon.blob === blob ? localIcon.src : undefined;
};

const safeIconUrl = (remoteUrl: string): string | undefined => {
  if (!URL.canParse(remoteUrl)) {
    return undefined;
  }
  const parsed = new URL(remoteUrl);
  return parsed.protocol === "https:" ? parsed.href : undefined;
};
