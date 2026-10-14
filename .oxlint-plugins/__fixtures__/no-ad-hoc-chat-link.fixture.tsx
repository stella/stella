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
