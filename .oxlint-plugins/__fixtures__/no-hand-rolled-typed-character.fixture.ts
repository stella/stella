// Passive regression fixture for
// `no-hand-rolled-typed-character/no-hand-rolled-typed-character`.

declare const typedCharacter: (event: KeyboardEvent) => string | null;

// Rejecting every Alt press drops "@" typed with Option on macOS layouts.
// oxlint-disable-next-line no-hand-rolled-typed-character/no-hand-rolled-typed-character -- fixture: an Alt veto before a one-character test must be rejected
const isEditKey = (event: KeyboardEvent) => {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.key.length === 1;
};

// Trusting AltGraph alone misses Chrome on macOS, which never reports it.
// oxlint-disable-next-line no-hand-rolled-typed-character/no-hand-rolled-typed-character -- fixture: an AltGraph-gated trigger must be rejected
const triggerFor = (event: KeyboardEvent) => {
  const isAltGraph = event.getModifierState("AltGraph");
  if (event.metaKey || (!isAltGraph && (event.altKey || event.ctrlKey))) {
    return null;
  }
  return event.key === "@" ? "context" : null;
};

// oxlint-disable-next-line no-hand-rolled-typed-character/no-hand-rolled-typed-character -- fixture: a switch over typed characters must be rejected
function menuFor(event: KeyboardEvent) {
  if (event.altKey) {
    return null;
  }
  switch (event.key) {
    case "/": {
      return "skills";
    }
    default: {
      return null;
    }
  }
}

// oxlint-disable-next-line no-hand-rolled-typed-character/no-hand-rolled-typed-character -- fixture: literal trigger sets must be rejected
const triggerSet = (event: KeyboardEvent) =>
  !event.altKey && ["@", "/"].includes(event.key);

// oxlint-disable-next-line no-hand-rolled-typed-character/no-hand-rolled-typed-character -- fixture: inverted length checks must be rejected
const lengthVeto = (event: KeyboardEvent) =>
  event.altKey || event.key.length !== 1;

// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const commandSet = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  ["c", "v"].includes(event.key);

// The helper decides; the handler only compares what it returns.
// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const triggerFromHelper = (event: KeyboardEvent) =>
  typedCharacter(event) === "@" ? "context" : null;

// Mod+A is a command shortcut: Alt rules out a different chord, not text.
// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const isSelectAll = (event: KeyboardEvent) => {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    (event.key !== "a" && event.key !== "A")
  ) {
    return false;
  }
  return true;
};

// A Mod chord required through `&&` is a shortcut too.
// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const isCopy = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && event.key === "c";

// Named keys are not typed characters.
// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const acceptsSuggestion = (event: KeyboardEvent) =>
  (event.key === "ArrowRight" || event.key === "Tab") &&
  !event.shiftKey &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.isComposing;

// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const copiesOnEnter = (event: KeyboardEvent) =>
  !event.isComposing &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  event.key === "Enter";

type Modifiers = {
  altGraphKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

// expect-clean: no-hand-rolled-typed-character/no-hand-rolled-typed-character
const hasPrimaryModifier = ({
  altGraphKey,
  altKey,
  ctrlKey,
  metaKey,
}: Modifiers) => (metaKey || ctrlKey) && !altKey && !altGraphKey;

export const __noHandRolledTypedCharacterFixture: readonly unknown[] = [
  triggerSet,
  lengthVeto,
  commandSet,
  isEditKey,
  triggerFor,
  menuFor,
  triggerFromHelper,
  isSelectAll,
  isCopy,
  acceptsSuggestion,
  copiesOnEnter,
  hasPrimaryModifier,
];
