import type { AnchorHTMLAttributes } from "react";

import { ChatLink } from "@stll/chat/link";

// oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: independent external anchor.
export const IndependentLink = () => <a href="https://example.org">Title</a>;
export const BrowserFavicon = () => (
  // oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: client-side favicon fetch.
  <img alt="" src="https://example.org/favicon.ico" />
);
// oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: markdown override bypasses classification and shared owner.
export const markdown = { a: () => <a href="https://example.org">Title</a> };

// expect-clean: no-ad-hoc-chat-link/no-ad-hoc-chat-link
export const SharedLink = () => (
  <ChatLink href="https://example.org">Title</ChatLink>
);
export const ParagraphJump = () => <a href="#paragraph">Jump</a>;
// oxlint-disable-next-line jsx-a11y/anchor-is-valid -- Fixture: anchors without a destination are ignored by this rule.
export const Label = () => <a>Label</a>;
// oxlint-disable-next-line jsx-a11y/anchor-is-valid -- Fixture: anchors without a destination are ignored by this rule.
export const IdOnly = () => <a id="label">Label</a>;
export const SpreadOnly = (props: AnchorHTMLAttributes<HTMLAnchorElement>) => (
  // oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: spread supplies an unknown destination.
  <a {...props}>Open matter</a>
);
export const FragmentThenSpread = (
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) => (
  // oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: trailing spread may replace the internal destination.
  <a href="#section" {...props}>
    Open matter
  </a>
);
export const RootThenSpread = (
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) => (
  // oxlint-disable-next-line no-ad-hoc-chat-link/no-ad-hoc-chat-link -- Negative fixture: trailing spread may replace the internal destination.
  <a href="/matter" {...props}>
    Open matter
  </a>
);
export const SpreadThenFragment = (
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) => (
  <a {...props} href="#section">
    Open matter
  </a>
);
export const SpreadThenRoot = (
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) => (
  <a {...props} href="/matter">
    Open matter
  </a>
);
