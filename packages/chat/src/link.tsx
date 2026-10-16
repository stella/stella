import { isValidElement, useState } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { GitHubLogoIcon, XLogoIcon } from "@stll/ui/brand-icons";
import { GlobeIcon } from "@stll/ui/icons";

import { normalizeChatLink } from "./link-detection";

export const CHAT_LINK_ATTRIBUTES = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

export const CHAT_LINK_CLASS_NAME =
  "text-foreground decoration-border hover:decoration-foreground rounded-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const linkText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(linkText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return linkText(node.props.children);
  }
  return "";
};

const ProxyIcon = ({ src }: { src: string }) => {
  const [failed, setFailed] = useState(false);
  // The host owns authenticated proxy retrieval; only its local object URL
  // enters this seam, so no renderer can expose the browser to an icon host.
  if (failed || !src.startsWith("blob:")) {
    return <GlobeIcon aria-hidden="true" className="size-[1em]" />;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-[1em] object-contain"
      onError={() => setFailed(true)}
      src={src}
    />
  );
};

export type ChatLinkIconSource = { type: "proxy"; src: string };

type ChatLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel" | "className"
> & {
  href: string;
  iconSource?: ChatLinkIconSource;
  newTabLabel?: string;
};

export const ChatLink = ({
  children,
  href,
  iconSource,
  newTabLabel,
  title,
  ...anchorProps
}: ChatLinkProps) => {
  const target = normalizeChatLink(href);
  if (!target) {
    const parsed = URL.canParse(href) ? new URL(href) : null;
    const safeLocal =
      href.startsWith("#") || /^(?:\/(?![\\/])|\.{1,2}\/)/u.test(href);
    const safeMail = parsed?.protocol === "mailto:";
    if ((!safeLocal && !safeMail) || /[\p{Cc}\p{Cf}]/u.test(href)) {
      return <span>{children ?? href}</span>;
    }
    return (
      <a
        {...anchorProps}
        title={newTabLabel ?? title}
        className={CHAT_LINK_CLASS_NAME}
        href={href}
        target={CHAT_LINK_ATTRIBUTES.target}
        rel={CHAT_LINK_ATTRIBUTES.rel}
      >
        <bdi>{children ?? href}</bdi>
      </a>
    );
  }
  const text = linkText(children).trim();
  const label =
    text && normalizeChatLink(text) === null
      ? children
      : target.hostname.replace(/^www\./u, "");
  let icon = <GlobeIcon aria-hidden="true" className="size-[1em]" />;
  if (iconSource) {
    icon = <ProxyIcon key={iconSource.src} src={iconSource.src} />;
  } else if (
    target.hostname === "github.com" ||
    target.hostname === "www.github.com"
  ) {
    icon = <GitHubLogoIcon aria-hidden="true" className="size-[1em]" />;
  } else if (
    ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      target.hostname,
    )
  ) {
    icon = <XLogoIcon aria-hidden="true" className="size-[1em]" />;
  }
  return (
    <a
      {...anchorProps}
      title={newTabLabel ?? title}
      className={CHAT_LINK_CLASS_NAME}
      href={target.href}
      target={CHAT_LINK_ATTRIBUTES.target}
      rel={CHAT_LINK_ATTRIBUTES.rel}
    >
      <span aria-hidden="true" className="me-1 inline-block align-[-0.125em]">
        {icon}
      </span>
      <bdi>{label}</bdi>
    </a>
  );
};
