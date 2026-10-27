declare const containsSearchMatchKey: (content: string, query: string) => boolean;
declare const createSearchQueryMatcher: (
  query: string,
) => (candidate: string) => boolean;
declare const item: { label: string; name: string };
declare const query: string;
declare const fileName: string;
declare const PDF_EXTENSION: string;
declare const Combobox: (props: {
  filter?: ((item: string, query: string) => boolean) | null;
  items?: readonly string[];
}) => null;
declare const Command: (props: {
  items?: readonly string[];
  mode?: "list" | "none";
}) => null;
declare const matchesComboboxItem: (item: string, query: string) => boolean;
declare const names: readonly string[];
declare const stripDiacritics: (text: string) => string;
declare const foldSearchMatchText: (text: string) => string;

const lowered = query.trim().toLowerCase();

// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a lowercase substring compare is reported
const _direct = item.label.toLowerCase().includes(query.toLowerCase());
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a folded binding as the receiver is reported
const _prefix = lowered.startsWith(query);
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a locale fold through a trimmed chain is reported
const _locale = item.name.toLocaleLowerCase("cs").trim().indexOf(query);
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a folded key fed to the literal key helper is reported
const _helper = containsSearchMatchKey(item.name.toLowerCase(), lowered);
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a self-filtering combobox without a filter is reported
const _collatorCombobox = <Combobox items={names} />;
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a filtering command without a filter is reported
const _collatorCommand = <Command items={names} mode="list" />;
// oxlint-disable-next-line no-case-folded-search-match/no-case-folded-search-match -- fixture proves a fold assembled from the owner's building blocks is reported
const _localFold = stripDiacritics(item.name);

// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _ownedFold = foldSearchMatchText(item.name);
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _owned =createSearchQueryMatcher(query)(item.label);
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _extension = fileName.toLowerCase().startsWith(".pdf");
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _constant = fileName.toLowerCase().includes(PDF_EXTENSION);
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _literalKey = containsSearchMatchKey(item.label, "MIME type");
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _caseSensitive = item.label.includes(query);
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _ownedCombobox = <Combobox filter={matchesComboboxItem} items={names} />;
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _externalCombobox = <Combobox filter={null} items={names} />;
// expect-clean: no-case-folded-search-match/no-case-folded-search-match
const _unfilteredCommand = <Command items={names} mode="none" />;
