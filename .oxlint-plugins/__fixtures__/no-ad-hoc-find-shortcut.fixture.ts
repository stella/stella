// Passive regression fixture for
// `no-ad-hoc-find-shortcut/no-ad-hoc-find-shortcut`.

declare const useEffectiveHotkey: (id: string) => string;
declare const HOTKEYS: { FIND: string; SEARCH: string };

const useFindBinding = () => ({
  // oxlint-disable-next-line no-ad-hoc-find-shortcut/no-ad-hoc-find-shortcut -- fixture: binding the registry's shortcut must be rejected
  rebound: useEffectiveHotkey("find"),
  // oxlint-disable-next-line no-ad-hoc-find-shortcut/no-ad-hoc-find-shortcut -- fixture: reading the registry's default chord must be rejected
  chord: HOTKEYS.FIND,
  // Other shortcuts stay untouched: the ban is about the find press, not
  // about the shortcut registry.
  untouched: [useEffectiveHotkey("search"), HOTKEYS.SEARCH],
});

// The two panes that drifted matched the press by hand, case-folded, so that
// shape has to fail wherever it is written.
const claimsBareShortcut = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  // oxlint-disable-next-line no-ad-hoc-find-shortcut/no-ad-hoc-find-shortcut -- fixture: case-folded key comparison must be rejected
  event.key.toLowerCase() === "f";

// oxlint-disable-next-line no-ad-hoc-find-shortcut/no-ad-hoc-find-shortcut, yoda -- fixture: a literal-first comparison must be rejected too
const claimsUppercase = (event: KeyboardEvent) => "F" === event.key;

// Other keys keep their own handlers.
const closesOnEscape = (event: KeyboardEvent) => event.key === "Escape";

export const __noAdHocFindShortcutFixture: readonly unknown[] = [
  useFindBinding,
  claimsBareShortcut,
  claimsUppercase,
  closesOnEscape,
];
