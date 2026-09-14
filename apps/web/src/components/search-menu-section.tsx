import type { PropsWithChildren } from "react";

export const SearchMenuSection = ({
  title,
  children,
}: PropsWithChildren<{ title: string }>) => (
  <section className="shrink-0 px-4 py-3">
    <h3 className="text-muted-foreground mb-2 text-xs font-medium">{title}</h3>
    <div className="space-y-1">{children}</div>
  </section>
);

export const SEARCH_MENU_ROW_CLASS_NAME =
  "h-auto min-h-11 min-w-0 w-full justify-start gap-2 border border-transparent px-2 py-2 text-start text-sm sm:h-auto [&_svg]:mx-0";
