import type { PropsWithChildren } from "react";

/**
 * A titled group of menu rows. Owns the group's inset, its heading and the
 * stack the rows sit in, so sibling lists in one panel share a rhythm; the rows
 * themselves carry `size="row"` (`MENU_ROW_CLASS_NAME`).
 */
const MenuSection = ({
  children,
  title,
}: PropsWithChildren<{ title: string }>) => (
  <section className="shrink-0 px-4 py-2" data-slot="menu-section">
    <h3 className="text-muted-foreground mb-1 text-xs font-medium">{title}</h3>
    <div className="space-y-0.5">{children}</div>
  </section>
);

export { MenuSection };
