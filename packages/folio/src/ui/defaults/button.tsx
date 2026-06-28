import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import type { FolioButtonProps } from "../folio-ui";

/**
 * Built-in, dependency-free Button used when a consumer does not inject one.
 *
 * Renders a native, accessible `<button>` honoring the `FolioButtonProps`
 * subset. Styling is intentionally minimal: variant and size map to a small
 * set of inline styles keyed off folio's `--doc-*` CSS variables (with safe
 * fallbacks) so the default chrome is usable standalone. Consumers that want
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
      className={cn("folio-default-button", className)}
      style={{ ...SIZE_STYLES[size], ...VARIANT_STYLES[variant] }}
      {...props}
    >
      {children}
    </button>
  );
}

const BASE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.375rem",
  borderRadius: "0.5rem",
  borderWidth: "1px",
  borderStyle: "solid",
  fontWeight: 500,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const SIZE_STYLES: Record<
  NonNullable<FolioButtonProps["size"]>,
  CSSProperties
> = {
  sm: {
    ...BASE_STYLE,
    height: "2rem",
    padding: "0 0.625rem",
    fontSize: "0.8125rem",
  },
  xs: {
    ...BASE_STYLE,
    height: "1.75rem",
    padding: "0 0.5rem",
    fontSize: "0.75rem",
  },
  "icon-xs": { ...BASE_STYLE, height: "1.75rem", width: "1.75rem", padding: 0 },
};

const VARIANT_STYLES: Record<
  NonNullable<FolioButtonProps["variant"]>,
  CSSProperties
> = {
  default: {
    background: "var(--doc-primary, #2563eb)",
    color: "var(--doc-primary-foreground, #ffffff)",
    borderColor: "var(--doc-primary, #2563eb)",
  },
  ghost: {
    background: "transparent",
    color: "var(--doc-text, inherit)",
    borderColor: "transparent",
  },
};
