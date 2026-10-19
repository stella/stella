import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type PlaybookWithName = {
  name: string;
};

export const filterPlaybooksByName = <T extends PlaybookWithName>(
  playbooks: readonly T[],
  query: string,
) => {
  const normalizedFilter = query.trim().toLocaleLowerCase();
  return normalizedFilter.length === 0
    ? playbooks
    : playbooks.filter((playbook) =>
        containsSearchMatchKey(
          playbook.name.toLocaleLowerCase(),
          normalizedFilter,
        ),
      );
};
