import type { ComponentProps } from "react";

import type { PublicLawTable } from "./public-law-table";

type Selection = NonNullable<
  ComponentProps<typeof PublicLawTable>["selection"]
>;
type IsRequired<T, TKey extends keyof T> =
  object extends Pick<T, TKey> ? false : true;
type Assert<T extends true> = T;

export type SelectionRequiresActions = Assert<IsRequired<Selection, "actions">>;
