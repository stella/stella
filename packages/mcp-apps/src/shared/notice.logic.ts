import type { searchView } from "../case-law-results/model";

type SearchPage = Extract<ReturnType<typeof searchView>, { type: "search" }>;
export type AppSearchWarning =
  SearchPage["searches"][number]["warnings"][number];

export const searchNoticeDetails = (warnings: readonly AppSearchWarning[]) => [
  ...new Set(
    warnings
      .filter(({ audience }) => audience === "user")
      .map(({ message }) => message),
  ),
];
