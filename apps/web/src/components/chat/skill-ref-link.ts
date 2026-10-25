import { linkOptions } from "@tanstack/react-router";

/**
 * Where a `[label](#stella-skill-ref=slug)` chip leads: the Tools catalogue
 * filtered to skills, with the named skill's detail panel open. Catalogue
 * entries for installed skills carry the same slug the chip does.
 */
export const skillRefDestination = (slug: string) =>
  linkOptions({
    to: "/knowledge/tools",
    search: { kind: "skill", slug },
  });
