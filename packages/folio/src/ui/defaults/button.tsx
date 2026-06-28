import { cn } from "../../lib/utils";
import type { FolioButtonProps } from "../folio-ui";

/**
 * Built-in, dependency-free Button used when a consumer does not inject one.
 *
 * Renders a native, accessible `<button>` honoring the `FolioButtonProps`
 * subset. The minimal default styling lives in `editor.css`
 * (`.folio-default-button*` classes, keyed off folio's `--doc-*` variables with
 * safe fallbacks) rather than inline styles, so a caller's `className` can
 * override the defaults through the normal cascade. Consumers that want
 * polished chrome inject their own design-system Button via `DocxEditor`'s
 * `components` prop.
 */
export function DefaultButton({
  variant = "default",
  size = "sm",
  className,
  children,
  ...props
}: FolioButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "folio-default-button",
        `folio-default-button--${variant}`,
        `folio-default-button--${size}`,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
