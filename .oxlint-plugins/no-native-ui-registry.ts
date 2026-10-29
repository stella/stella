// Which native markup each `@stll/ui` module replaces.
//
// Every module `packages/ui/package.json` exports has exactly one row here,
// keyed by its subpath with the grouped `components/`, `hooks/` and `lib/`
// aliases folded onto the flat name they duplicate. A row is one of:
//
//   native        the component replaces native markup; `no-native-ui`
//                 generates `no-native-ui/no-native-<module>` from `patterns`
//                 and points the reader at `use`.
//   owned         an existing rule already forbids the native markup this
//                 component replaces; `rule` names it, so the census does not
//                 grow a second rule for the same thing.
//   no-native     a component with no native counterpart to forbid; `reason`
//                 says why.
//   not-component the export is a hook, helper, token set or stylesheet.
//
// `.oxlint-plugins/__tests__/no-native-ui-registry.test.ts` fails when an
// export has no row, a row names no export, a generated rule is not enabled
// for product code, an owned rule is not configured, or a generated rule has
// no passive fixture line.
//
// This module has no default export: the rule census imports every top-level
// module here and counts only the ones that export a plugin.

/** Native markup that hand-rolls what a component provides. */
export type NativePatterns = {
  /** Intrinsic elements (`<hr>`, `<select>`), matched by exact tag name. */
  readonly elements?: readonly string[];
  /**
   * Literal `role` values on any element, the design system's included: a
   * `<Button role="switch">` hand-rolls a switch as surely as a `<div>` does.
   * Both branches of a ternary are read.
   */
  readonly roles?: readonly string[];
  /**
   * `type` values on `<input>` and on the `@stll/ui` `Input`, which forwards
   * `type` to the native control it renders.
   */
  readonly inputTypes?: readonly string[];
  /** Attributes on intrinsic elements that switch on native behaviour. */
  readonly attributes?: readonly NativeAttribute[];
};

export type NativeAttribute = {
  /** Matched case-insensitively, so `popoverTarget` and `popovertarget` agree. */
  readonly name: string;
  /** Literal values that count; every value counts when omitted. */
  readonly values?: readonly string[];
  /** Intrinsic elements on which the attribute means something else. */
  readonly exceptOn?: readonly string[];
};

export type NoNativeUiEntry =
  | {
      readonly kind: "native";
      /** What to render instead, as the message prints it. */
      readonly use: string;
      readonly patterns: NativePatterns;
    }
  | { readonly kind: "owned"; readonly rule: string; readonly reason: string }
  | { readonly kind: "no-native"; readonly reason: string }
  | { readonly kind: "not-component"; readonly reason: string };

const native = (use: string, patterns: NativePatterns) =>
  ({ kind: "native", use, patterns }) as const;

const owned = (rule: string, reason: string) =>
  ({ kind: "owned", rule, reason }) as const;

const noNative = (reason: string) => ({ kind: "no-native", reason }) as const;

const notComponent = (reason: string) =>
  ({ kind: "not-component", reason }) as const;

/** The rule id `no-native-ui` generates for one module. */
export const nativeRuleName = (module: string): string => `no-native-${module}`;

export const NO_NATIVE_UI_PLUGIN = "no-native-ui";

export const nativeRuleId = (module: string): string =>
  `${NO_NATIVE_UI_PLUGIN}/${nativeRuleName(module)}`;

const DATE_INPUT_RULE = "no-raw-date-input/no-raw-date-input";
const FILE_INPUT_RULE = "no-raw-file-input/no-raw-file-input";
const LOADER_RULE = "no-adhoc-loader/no-adhoc-loader";
const OVERFLOW_RULE = "no-raw-overflow-scroll/no-raw-overflow-scroll";
const AVATAR_RULE = "no-raw-user-avatar-primitive/no-raw-user-avatar-primitive";

export const NO_NATIVE_UI_REGISTRY = {
  ".": notComponent("the package barrel; each module has its own row"),
  accordion: native("Accordion from @stll/ui/accordion", {
    elements: ["details", "summary"],
  }),
  "ai-label": noNative("a badge marking AI-generated content"),
  "alert-dialog": native("AlertDialog from @stll/ui/alert-dialog", {
    roles: ["alertdialog"],
  }),
  "animated-count": noNative("animates a number's digits"),
  "application-rail": noNative("app navigation chrome built from Button"),
  avatar: owned(AVATAR_RULE, "user avatars render through UserIdentity"),
  badge: noNative(
    "HTML has no badge element or role; a hand-styled pill is a span no " +
      "lexical pattern tells apart from other inline text",
  ),
  "bidi-text": owned(
    "require-dir-on-rendered-name/require-dir-on-rendered-name",
    "raw <bdi>, <bdo> and dir on rendered names are reported there",
  ),
  "brand-icons": noNative("third-party brand artwork drawn as SVG"),
  breadcrumb: noNative(
    "HTML has no breadcrumb element or role; a hand-rolled trail is links " +
      "and separators no lexical pattern tells apart from other link rows",
  ),
  "browser-clock": notComponent("a test clock for browser tests"),
  button: native("Button from @stll/ui/button", {
    elements: ["button"],
    roles: ["button"],
    inputTypes: ["button", "image", "reset", "submit"],
  }),
  calendar: owned(
    DATE_INPUT_RULE,
    "the native date pickers are reported there",
  ),
  checkbox: native("Checkbox from @stll/ui/checkbox", {
    roles: ["checkbox"],
    inputTypes: ["checkbox"],
  }),
  "color-picker": native("ColorPicker from @stll/ui/color-picker", {
    inputTypes: ["color"],
  }),
  combobox: native("Combobox from @stll/ui/combobox", {
    elements: ["datalist"],
    roles: ["combobox"],
  }),
  command: owned(
    nativeRuleId("combobox"),
    "a command palette is a combobox over actions",
  ),
  composer: noNative("the chat composer surface"),
  "composer-tokens": notComponent("composer style tokens"),
  "context-menu": owned(
    nativeRuleId("menu"),
    "a context menu is a menu opened by the pointer",
  ),
  "control-size": notComponent("control size tokens"),
  "copy-button": noNative(
    "a Button with clipboard feedback; its markup is the button rule's",
  ),
  "court-badge": noNative("a domain badge for a court"),
  "data-table": owned(
    nativeRuleId("table"),
    "native table markup is reported by the table rule",
  ),
  "date-picker-popover": owned(
    DATE_INPUT_RULE,
    "the native date pickers are reported there",
  ),
  "date-range-filter": owned(
    "no-hand-built-date-range-filter/no-hand-built-date-range-filter",
    "hand-built range filters are reported there",
  ),
  "destructive-action-confirmation": owned(
    "eslint/no-alert",
    "the browser's confirm() dialog is reported there",
  ),
  "destructive-confirm-dialog": owned(
    "eslint/no-alert",
    "the browser's confirm(), alert() and prompt() dialogs are reported there",
  ),
  "details-grid": native("DetailsGrid from @stll/ui/details-grid", {
    elements: ["dl", "dt", "dd"],
  }),
  dialog: native("Dialog from @stll/ui/dialog", {
    elements: ["dialog"],
    roles: ["dialog"],
    attributes: [{ name: "aria-modal" }],
  }),
  "directional-icon": noNative("mirrors an icon under a right-to-left UI"),
  "document-identity-badge": noNative("a domain badge for a document"),
  "document-identity-badge.logic": notComponent("badge formatting helpers"),
  field: owned(
    nativeRuleId("label"),
    "Field pairs a Label with a control; the native label is the label rule's",
  ),
  "file-input": owned(FILE_INPUT_RULE, "native file inputs are reported there"),
  "file-picker": notComponent(
    "an imperative file chooser; native file inputs are no-raw-file-input's",
  ),
  form: native("Form from @stll/ui/form", { elements: ["form"] }),
  frame: noNative("a layout surface with header and footer slots"),
  "hex-color-picker": owned(
    nativeRuleId("color-picker"),
    "the native colour input is reported by the colour picker rule",
  ),
  "horizontal-scroller": owned(
    OVERFLOW_RULE,
    "raw overflow scrolling is reported there",
  ),
  icons: owned(
    "no-direct-lucide-import/no-direct-lucide-import",
    "glyphs come from @stll/ui/icons, never the icon library directly",
  ),
  "inline-drop-indicator": noNative("a drag-and-drop insertion marker"),
  "inline-rename": owned(
    "no-ad-hoc-inline-rename/no-ad-hoc-inline-rename",
    "hand-rolled rename inputs are reported there",
  ),
  "inline-reorder": notComponent("keyboard reordering helpers"),
  initials: notComponent("initials derivation"),
  input: native("Input from @stll/ui/input", { elements: ["input"] }),
  "input-group": owned(
    nativeRuleId("input"),
    "InputGroup decorates Input; the native input is the input rule's",
  ),
  "input-otp": native("InputOTP from @stll/ui/input-otp", {
    attributes: [{ name: "autoComplete", values: ["one-time-code"] }],
  }),
  inspector: noNative("the inspector panel layout"),
  kanban: noNative("a board layout"),
  label: native("Label from @stll/ui/label", { elements: ["label"] }),
  landing: noNative("landing page sections"),
  "layout-tokens": notComponent("inspector layout tokens"),
  list: noNative(
    "grouped settings rows; a plain <ul> or <ol> is ordinary markup",
  ),
  loader: owned(LOADER_RULE, "hand-rolled spinners are reported there"),
  "matter-colors": notComponent("matter colour tokens"),
  "matter-icon": owned(
    "no-direct-matter-glyph/no-direct-matter-glyph",
    "the raw matter glyph is reported there",
  ),
  menu: native("Menu from @stll/ui/menu", {
    elements: ["menu"],
    roles: ["menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio"],
  }),
  "menu-section": owned(
    nativeRuleId("menu"),
    "a labelled group inside Menu; native menus are the menu rule's",
  ),
  "number-input": native("NumberInput from @stll/ui/number-input", {
    roles: ["spinbutton"],
    inputTypes: ["number"],
  }),
  "option-color": notComponent("option colour tokens"),
  "outline-rail": noNative("document outline navigation built from Button"),
  "overlay-layer": notComponent("overlay stacking tokens"),
  pagination: noNative(
    "HTML has no pagination element or role; a hand-rolled pager is " +
      "buttons and text no lexical pattern tells apart from other button rows",
  ),
  "panel-inset": notComponent("panel spacing tokens"),
  popover: native("Popover from @stll/ui/popover", {
    attributes: [{ name: "popover" }, { name: "popoverTarget" }],
  }),
  "positioner-sizing": notComponent("popup sizing helpers"),
  "preview-card": owned(
    nativeRuleId("popover"),
    "a hover-opened popover; the native popover is the popover rule's",
  ),
  "preview-pane": noNative("a menu preview layout"),
  prose: owned(
    "narrative-prose-component/require-prose",
    "narrative paragraphs outside Prose are reported there",
  ),
  "review-author-avatar": owned(
    AVATAR_RULE,
    "author avatars render through the avatar owner",
  ),
  "review-comment-card": noNative("a review comment presentation"),
  "review-decision-actions": noNative("review accept and reject actions"),
  "review-diff-text": noNative("tracked-change text presentation"),
  "review-out-of-date-notice": noNative("a review staleness notice"),
  "review-severity-dot": noNative("a review severity marker"),
  "review-status-badge": noNative("a review status badge"),
  "review-word-diff": notComponent("word diff computation"),
  "scroll-area": owned(
    OVERFLOW_RULE,
    "raw overflow scrolling is reported there",
  ),
  "scroll-to-top": noNative(
    "a floating Button bound to a scroll container; its markup is the button rule's",
  ),
  "search-field": owned(
    nativeRuleId("input"),
    "a raw search input is reported by the input rule, a decorated Input by " +
      "no-decorated-search-input",
  ),
  "secret-input": native("SecretInput from @stll/ui/secret-input", {
    inputTypes: ["password"],
  }),
  "segmented-icon-toggle": noNative(
    "a row of pressed-state Buttons; native radio groups have no @stll/ui " +
      "counterpart yet, so radios stay allowed",
  ),
  select: native("Select from @stll/ui/select", {
    elements: ["select", "option", "optgroup"],
    roles: ["listbox", "option"],
  }),
  separator: native("Separator from @stll/ui/separator", {
    elements: ["hr"],
    roles: ["separator"],
  }),
  sheet: owned(
    nativeRuleId("dialog"),
    "a sheet is an edge-anchored dialog; native dialogs are the dialog rule's",
  ),
  sidebar: noNative("app navigation chrome"),
  skeleton: owned(
    LOADER_RULE,
    "hand-rolled pulsing placeholders are reported there",
  ),
  "split-button": noNative(
    "a Button and a Menu side by side; each part has its own rule",
  ),
  "status-mark": noNative("a status glyph"),
  "stella-mark": owned(
    "no-placeholder-stella-mark/no-placeholder-stella-mark",
    "placeholder marks are reported there",
  ),
  "stella-wordmark": noNative("the product wordmark"),
  steps: owned(
    "no-hand-built-step-marker/no-hand-built-step-marker",
    "hand-built step markers are reported there",
  ),
  "swap-text": noNative("animates between two strings"),
  switch: native("Switch from @stll/ui/switch", { roles: ["switch"] }),
  table: native("Table from @stll/ui/table", {
    elements: ["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
    roles: [
      "table",
      "grid",
      "row",
      "rowgroup",
      "cell",
      "gridcell",
      "columnheader",
      "rowheader",
    ],
  }),
  "table-chart": noNative("a chart drawn from table data"),
  tabs: native("Tabs from @stll/ui/tabs", {
    roles: ["tablist", "tab", "tabpanel"],
  }),
  text: noNative(
    "text in one of the design system's roles; a <span> or <p> is ordinary " +
      "markup on the web",
  ),
  "text-mark": owned(
    "no-ad-hoc-text-mark/no-ad-hoc-text-mark",
    "raw <mark> and hand-styled marks are reported there",
  ),
  textarea: native("Textarea from @stll/ui/textarea", {
    elements: ["textarea"],
  }),
  "theme.css": notComponent("the design-system stylesheet"),
  toast: owned(
    "stella-toast/stella-toast",
    "toasts go through stellaToast; the browser's alert() is no-alert's",
  ),
  "toolbar-icon-action": owned(
    nativeRuleId("button"),
    "an icon Button with a tooltip; the native button is the button rule's",
  ),
  tooltip: native("Tooltip from @stll/ui/tooltip", {
    roles: ["tooltip"],
    attributes: [
      {
        name: "title",
        // A frame's title names it for assistive technology, an abbreviation
        // carries its expansion, and a stylesheet link its alternate-set name;
        // none of them is a hover hint.
        exceptOn: ["abbr", "iframe", "link", "style"],
      },
    ],
  }),
  "truncated-text": owned(
    nativeRuleId("tooltip"),
    "a title on truncated text is reported by the tooltip rule",
  ),
  "typed-character": notComponent("keystroke classification"),
  "use-contained-handler": notComponent("a React hook"),
  "use-content-dir": notComponent("a React hook"),
  "use-latest": notComponent("a React hook"),
  "use-mobile": notComponent("a React hook"),
  "use-viewport-width": notComponent("a React hook"),
  utils: notComponent("class name helpers"),
  "view-toolbar": noNative(
    "a view's filter row; ARIA toolbars have no general @stll/ui primitive",
  ),
  week: notComponent("week arithmetic"),
  "workspace-shell": noNative("the workspace page layout"),
} as const satisfies Record<string, NoNativeUiEntry>;

type Registry = typeof NO_NATIVE_UI_REGISTRY;

/** The modules whose row generates a rule. */
export type NativeModule = {
  [Module in keyof Registry]: Registry[Module]["kind"] extends "native"
    ? Module
    : never;
}[keyof Registry];

/** One generated rule's row. */
export const nativeEntry = (module: NativeModule) =>
  NO_NATIVE_UI_REGISTRY[module];

/**
 * `<input>` types the input rule leaves alone because another rule owns them
 * or no `@stll/ui` component replaces them yet. Types a generated rule claims
 * (`checkbox`, `number`, ...) are added by the plugin from the registry.
 */
export const INPUT_TYPES_OUTSIDE_INPUT_RULE: Readonly<Record<string, string>> =
  {
    date: DATE_INPUT_RULE,
    "datetime-local": DATE_INPUT_RULE,
    month: DATE_INPUT_RULE,
    time: DATE_INPUT_RULE,
    week: DATE_INPUT_RULE,
    file: FILE_INPUT_RULE,
    hidden: "carries form data and renders nothing",
    radio: "no @stll/ui radio group yet",
    range: "no @stll/ui slider yet",
  };

/** The modules that generate a rule, with their patterns. */
export const nativeEntries = (): {
  module: string;
  use: string;
  patterns: NativePatterns;
}[] =>
  Object.entries(NO_NATIVE_UI_REGISTRY).flatMap(
    ([module, entry]: [string, NoNativeUiEntry]) =>
      entry.kind === "native"
        ? [{ module, use: entry.use, patterns: entry.patterns }]
        : [],
  );

/**
 * The registry key for one `packages/ui` export subpath: the grouped aliases
 * fold onto the flat name they duplicate.
 */
export const registryKeyForExport = (subpath: string): string => {
  if (subpath === ".") {
    return ".";
  }
  const name = subpath.replace(/^\.\//u, "");
  return name.replace(/^(?:components|hooks|lib)\//u, "");
};
