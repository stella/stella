import { useState } from "react";
import type { ComponentProps } from "react";

import { useQuery } from "@tanstack/react-query";

import { ChatLink, hasBundledChatLinkIcon } from "@stll/chat/link";
import type { ChatLinkIconSource } from "@stll/chat/link";
import { getChatLinkSite, normalizeChatLink } from "@stll/chat/link-detection";

import { linkIconOptions } from "@/features/chat/link-icons";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type ProxyChatLinkProps = Omit<
  ComponentProps<typeof ChatLink>,
  "iconSource"
> & {
  iconSource: { kind: "tool-source" } | { kind: "model-text" };
};

export const ProxyChatLink = ({
  iconSource: source,
  ...props
}: ProxyChatLinkProps) => {
  const hostname = normalizeChatLink(props.href)?.hostname ?? "";
  const site = getChatLinkSite(hostname) ?? "";
  const [visible, setVisible] = useState(false);
  const { data: icon, isError } = useQuery({
    ...linkIconOptions(site),
    enabled:
      source.kind === "tool-source" &&
      visible &&
      site !== "" &&
      !hasBundledChatLinkIcon(hostname),
  });
  const blob = icon?.type === "icon" ? icon.blob : undefined;
  const [localIcon, setLocalIcon] = useState<{
    blob: Blob;
    source: ChatLinkIconSource;
  } | null>(null);

  const observeVisibility = (element: HTMLSpanElement | null) => {
    if (!element || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) {
        setVisible(entry.isIntersecting);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  };

  useExternalSyncEffect(() => {
    if (!blob) {
      return undefined;
    }
    const src = URL.createObjectURL(blob);
    setLocalIcon({ blob, source: { type: "proxy", src } });
    return () => URL.revokeObjectURL(src);
  }, [blob]);

  const iconSource =
    !isError && localIcon?.blob === blob ? localIcon?.source : undefined;
  return (
    <span ref={observeVisibility}>
      <ChatLink {...props} iconSource={iconSource} />
    </span>
  );
};
