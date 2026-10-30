import { isValidElement, useId, useState } from "react";
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";

import { GitHubLogoIcon, XLogoIcon } from "@stll/ui/brand-icons";
import { GlobeIcon } from "@stll/ui/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

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

const GITHUB_LINK_ICON = (
  <GitHubLogoIcon aria-hidden="true" className="size-[1em]" />
);
const X_LINK_ICON = <XLogoIcon aria-hidden="true" className="size-[1em]" />;
const BUNDLED_ICONS = new Map([
  ["github.com", GITHUB_LINK_ICON],
  ["www.github.com", GITHUB_LINK_ICON],
  ["x.com", X_LINK_ICON],
  ["www.x.com", X_LINK_ICON],
  ["twitter.com", X_LINK_ICON],
  ["www.twitter.com", X_LINK_ICON],
]);

export const hasBundledChatLinkIcon = (hostname: string): boolean =>
  BUNDLED_ICONS.has(hostname);

export type ChatLinkIconSource = { type: "proxy"; src: string };

type ChatLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel" | "className"
> & {
  href: string;
  appearance?: "inline" | "tray";
  iconSource?: ChatLinkIconSource | undefined;
  newTabLabel?: string;
};

/**
 * The hover hint a link carries: the new-tab notice, or the title the source
 * gave it. A link with neither renders bare, so a long answer does not mount
 * a tooltip for every link it has nothing to say about. The tooltip is for the
 * pointer; the same words reach assistive technology as the link's
 * description (see `HintDescription`).
 */
const LinkHint = ({
  children,
  hint,
}: {
  children: ReactElement;
  hint: string | undefined;
}) =>
  hint ? (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  ) : (
    children
  );

/** The hint as the link's accessible description, which a tooltip is not. */
const HintDescription = ({
  hint,
  id,
}: {
  hint: string | undefined;
  id: string;
}) =>
  hint ? (
    <span hidden id={id}>
      {hint}
    </span>
  ) : null;

export const ChatLink = ({
  appearance = "inline",
  children,
  href,
  iconSource,
  newTabLabel,
  title,
  ...anchorProps
}: ChatLinkProps) => {
  const hint = newTabLabel ?? title;
  const hintId = useId();
  const className =
    appearance === "tray"
      ? "bg-muted/50 hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      : CHAT_LINK_CLASS_NAME;
  const labelClassName =
    appearance === "tray" ? "max-w-[20ch] truncate" : undefined;
  const target = normalizeChatLink(href);
  if (!target) {
    const parsed = URL.canParse(href) ? new URL(href) : null;
    const safeLocal =
      href.startsWith("#") || /^(?:\/(?![\\/])|\.{1,2}\/)/u.test(href);
    const safeMail = parsed?.protocol === "mailto:";
    if ((!safeLocal && !safeMail) || /[\p{Cc}\p{Cf}]/u.test(href)) {
      return appearance === "tray" ? (
        <span className={className}>
          <bdi className={labelClassName}>{children ?? href}</bdi>
        </span>
      ) : (
        <span>{children ?? href}</span>
      );
    }
    return (
      <LinkHint hint={hint}>
        <a
          {...anchorProps}
          aria-describedby={hint ? hintId : anchorProps["aria-describedby"]}
          className={className}
          href={href}
          target={CHAT_LINK_ATTRIBUTES.target}
          rel={CHAT_LINK_ATTRIBUTES.rel}
        >
          <bdi className={labelClassName}>{children ?? href}</bdi>
          <HintDescription hint={hint} id={hintId} />
        </a>
      </LinkHint>
    );
  }
  const text = linkText(children).trim();
  const label =
    text && normalizeChatLink(text) === null
      ? children
      : target.hostname.replace(/^www\./u, "");
  let icon = <GlobeIcon aria-hidden="true" className="size-[1em]" />;
  const bundledIcon = BUNDLED_ICONS.get(target.hostname);
  if (iconSource) {
    icon = <ProxyIcon key={iconSource.src} src={iconSource.src} />;
  } else if (bundledIcon) {
    icon = bundledIcon;
  }
  return (
    <LinkHint hint={hint}>
      <a
        {...anchorProps}
        aria-describedby={hint ? hintId : anchorProps["aria-describedby"]}
        className={className}
        href={target.href}
        target={CHAT_LINK_ATTRIBUTES.target}
        rel={CHAT_LINK_ATTRIBUTES.rel}
      >
        <span
          aria-hidden="true"
          className={
            appearance === "tray"
              ? "inline-block shrink-0"
              : "me-1 inline-block align-[-0.125em]"
          }
        >
          {icon}
        </span>
        <bdi className={labelClassName}>{label}</bdi>
        <HintDescription hint={hint} id={hintId} />
      </a>
    </LinkHint>
  );
};
