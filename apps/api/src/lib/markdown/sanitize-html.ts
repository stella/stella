import { decodeHTMLAttribute } from "entities";

const REMOVE_ENTIRELY = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "textarea",
]);

const HREF_BASE = "https://placeholder.invalid";

type HtmlSanitizerOptions = {
  allowedTags: ReadonlySet<string>;
  allowedAttrs: Record<string, ReadonlySet<string>>;
  allowedHrefSchemes: ReadonlySet<string>;
  /** An href kept as written without the scheme check, such as an in-app link. */
  isAllowedLocalHref?: (href: string) => boolean;
};

/**
 * Allowlist-based HTML sanitizer using HTMLRewriter: drops script-like
 * elements with their content, unwraps any other tag not allowed, strips
 * attributes not allowed, and removes an anchor href whose scheme is not.
 */
export const createHtmlSanitizer =
  ({
    allowedTags,
    allowedAttrs,
    allowedHrefSchemes,
    isAllowedLocalHref,
  }: HtmlSanitizerOptions) =>
  (html: string): string =>
    new HTMLRewriter()
      .on("*", {
        element(el) {
          const tagName = el.tagName;
          if (REMOVE_ENTIRELY.has(tagName)) {
            el.remove();
            return;
          }
          if (!allowedTags.has(tagName)) {
            el.removeAndKeepContent();
            return;
          }
          const allowed = allowedAttrs[tagName];
          const toRemove: string[] = [];
          for (const [name] of el.attributes) {
            if (!allowed?.has(name)) {
              toRemove.push(name);
            }
          }
          for (const name of toRemove) {
            el.removeAttribute(name);
          }
          if (tagName !== "a") {
            return;
          }
          const rawHref = el.getAttribute("href");
          if (!rawHref) {
            return;
          }
          // getAttribute returns the attribute text as written; downstream
          // consumers decode entities, so validate the decoded value and emit
          // exactly what was checked.
          const href = decodeHTMLAttribute(rawHref);
          if (isAllowedLocalHref?.(href)) {
            el.setAttribute("href", href);
            return;
          }
          if (!URL.canParse(href, HREF_BASE)) {
            el.removeAttribute("href");
            return;
          }
          const url = new URL(href, HREF_BASE);
          if (!allowedHrefSchemes.has(url.protocol)) {
            el.removeAttribute("href");
            return;
          }
          el.setAttribute("href", href);
        },
      })
      .transform(html);
