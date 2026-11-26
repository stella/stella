import { useState } from "react";
import type { ComponentProps } from "react";

import { useQuery } from "@tanstack/react-query";

import { ChatLink, hasBundledChatLinkIcon } from "@stll/chat/link";
import type { ChatLinkIconSource } from "@stll/chat/link";
import { getChatLinkSite, normalizeChatLink } from "@stll/chat/link-detection";
import { useIntersecting, useObjectUrl } from "@stll/ui/effects/dom";

import { linkIconOptions } from "@/features/chat/link-icons";

/** Only links from a tool-returned source may fetch a site icon. */
export type LinkIconSource = { kind: "tool-source" } | { kind: "model-text" };

type ProxyChatLinkProps = Omit<
  ComponentProps<typeof ChatLink>,
  "iconSource"
> & {
  iconSource: LinkIconSource;
};

export const ProxyChatLink = ({
  iconSource: source,
  ...props
}: ProxyChatLinkProps) => {
  const hostname = normalizeChatLink(props.href)?.hostname ?? "";
  const site = getChatLinkSite(hostname) ?? "";
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const visible = useIntersecting(element);
  const { data: icon, isError } = useQuery({
    ...linkIconOptions(site),
    enabled:
      source.kind === "tool-source" &&
      visible &&
      site !== "" &&
      !hasBundledChatLinkIcon(hostname),
  });
  // A disabled query still exposes data another link cached for the site.
  const blob =
    source.kind === "tool-source" &&
    !hasBundledChatLinkIcon(hostname) &&
    icon?.type === "icon"
      ? icon.blob
      : undefined;
  const iconUrl = useObjectUrl(blob);

  const iconSource: ChatLinkIconSource | undefined =
    !isError && iconUrl !== undefined
      ? { type: "proxy", src: iconUrl }
      : undefined;
  return (
    <span ref={setElement}>
      <ChatLink {...props} iconSource={iconSource} />
    </span>
  );
};
