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

/**
 * What a component is in the React Native app (apps/mobile), the registry's
 * second column. Every component row has one:
 *
 *   renderer   `<module>.native.tsx` renders the component's shared contract
 *              and package.json resolves the module to it under the
 *              `react-native` condition. `replaces` lists the React Native
 *              components (imported from "react-native") the app must not
 *              render in its place; the module's `no-native-<module>` rule
 *              reports them in apps/mobile. `TextInput[multiline]` names a
 *              TextInput with a `multiline` attribute, which a plain
 *              `TextInput` entry then leaves to that rule.
 *   web-only   no native renderer; `reason` says why a phone does without.
 *
 * The registry test fails when a component has neither, when a renderer has
 * no `react-native` export or a web-only module has one, or when two rules
 * claim one React Native component.
 */
export type ReactNativeColumn =
  | {
      readonly kind: "renderer";
      readonly use: string;
      readonly replaces: readonly string[];
    }
  | { readonly kind: "web-only"; readonly reason: string };

const renderer = (use: string, replaces: readonly string[]) =>
  ({ kind: "renderer", use, replaces }) as const;

const webOnly = (reason: string) => ({ kind: "web-only", reason }) as const;

/** The modules whose row is a component (not a hook, helper or token set). */
export type ComponentModule = {
  [Module in keyof Registry]: Registry[Module]["kind"] extends "not-component"
    ? never
    : Module;
}[keyof Registry];

export const NO_NATIVE_UI_REACT_NATIVE = {
  accordion: webOnly(
    "a phone discloses a section by navigating to it or through a native list section; the app has no disclosure row yet",
  ),
  "ai-label": webOnly(
    "marks AI output in the web's review surfaces, which the app does not show",
  ),
  "alert-dialog": webOnly(
    "a phone confirms through the platform's own alert (Alert.alert), which needs no wrapper",
  ),
  "animated-count": webOnly(
    "a web number animation; the app shows counts as plain text",
  ),
  "application-rail": webOnly(
    "the web's navigation chrome; the app navigates with the platform's tab bar",
  ),
  avatar: webOnly("the app shows no user avatars yet"),
  badge: webOnly("a web status pill; the app shows no badges yet"),
  "bidi-text": webOnly(
    "React Native lays out bidirectional text through the platform; there is no <bdi> to wrap",
  ),
  "brand-icons": webOnly("third-party sign-in artwork the app does not draw"),
  breadcrumb: webOnly("a phone navigates with a back stack, not a trail"),
  button: renderer("Button from @stll/ui/button", [
    "Pressable",
    "TouchableOpacity",
    "TouchableHighlight",
    "TouchableWithoutFeedback",
    "TouchableNativeFeedback",
    "Button",
  ]),
  calendar: webOnly("a phone picks a date with the platform's picker"),
  checkbox: webOnly(
    "iOS has no checkbox control; a binary choice on a phone is a Switch",
  ),
  "color-picker": webOnly("the app does not edit colours"),
  combobox: webOnly(
    "a phone picks from a list on its own screen or sheet (a searchable list), not a dropdown",
  ),
  command: webOnly(
    "the app's palette is a sheet of Button rows over a search Input",
  ),
  composer: webOnly(
    "the web's rich-text composer; the app composes from the shared composer tokens with Textarea and Button",
  ),
  "context-menu": webOnly(
    "a phone opens a context menu through the platform (expo-router Link.Menu)",
  ),
  "copy-button": webOnly(
    "a Button with clipboard feedback the app does not offer yet",
  ),
  "court-badge": webOnly("a web review badge the app does not show"),
  "data-table": webOnly("a phone lists records in rows, not a table"),
  "date-picker-popover": webOnly(
    "a phone picks a date with the platform's picker",
  ),
  "date-range-filter": webOnly("the app has no date-range filters"),
  "destructive-action-confirmation": webOnly(
    "a phone confirms through the platform's own alert",
  ),
  "destructive-confirm-dialog": webOnly(
    "a phone confirms through the platform's own alert",
  ),
  "details-grid": webOnly(
    "a phone stacks labelled values as rows, not a definition grid",
  ),
  dialog: webOnly(
    "a phone presents modal content as a page sheet (@stll/ui/sheet), which owns the platform's Modal",
  ),
  "directional-icon": webOnly(
    "React Native mirrors layout for right-to-left itself",
  ),
  "document-identity-badge": webOnly(
    "a web review badge the app does not show",
  ),
  field: webOnly(
    "the app labels a control with Text above it; there is no <label> element to pair",
  ),
  "file-input": webOnly(
    "a phone picks files through the platform's document picker",
  ),
  form: webOnly(
    "React Native has no form element; a screen submits from its own Button",
  ),
  frame: webOnly("a web layout surface; screens lay out with View"),
  "hex-color-picker": webOnly("the app does not edit colours"),
  "horizontal-scroller": webOnly("ScrollView scrolls natively on a phone"),
  icons: webOnly(
    "the app draws the same entries from lucide-react-native through its generated icon module",
  ),
  "inline-drop-indicator": webOnly("the app has no drag and drop"),
  "inline-rename": webOnly("the app renames nothing inline yet"),
  input: renderer("Input from @stll/ui/input", ["TextInput"]),
  "input-group": webOnly(
    "a web input decoration; a phone field carries no inline addons yet",
  ),
  "input-otp": webOnly(
    "the app signs in through the browser, not a code field",
  ),
  inspector: webOnly(
    "the web's docked inspector; a phone shows details on their own screen",
  ),
  kanban: webOnly("a phone has no room for a board"),
  label: webOnly(
    "React Native has no label element; Text names the control above it",
  ),
  landing: webOnly("marketing sections for the website"),
  list: webOnly(
    'the app\'s lists are FlatList rows of Button size="row" divided by Separator',
  ),
  loader: renderer("Loader from @stll/ui/loader", ["ActivityIndicator"]),
  "matter-icon": renderer("MatterIcon from @stll/ui/matter-icon", []),
  menu: webOnly(
    "a phone opens menus through the platform (expo-router Link.Menu, native header menus)",
  ),
  "menu-section": webOnly("a phone opens menus through the platform"),
  "number-input": webOnly("the app enters no numbers yet"),
  "outline-rail": webOnly(
    "the web's document outline; the app shows no outline",
  ),
  pagination: webOnly("a phone loads more as a list scrolls"),
  popover: webOnly("a phone has no anchored popovers; it uses a sheet"),
  "preview-card": webOnly("a hover card; a phone has no hover"),
  "preview-pane": webOnly("a web menu preview layout"),
  prose: webOnly(
    "a web prose stylesheet; the app sets paragraphs with Text roles",
  ),
  "review-author-avatar": webOnly("the app shows no review surfaces"),
  "review-comment-card": webOnly("the app shows no review surfaces"),
  "review-decision-actions": webOnly("the app shows no review surfaces"),
  "review-diff-text": webOnly("the app shows no review surfaces"),
  "review-out-of-date-notice": webOnly("the app shows no review surfaces"),
  "review-severity-dot": webOnly("the app shows no review surfaces"),
  "review-status-badge": webOnly("the app shows no review surfaces"),
  "scroll-area": webOnly("ScrollView scrolls natively on a phone"),
  "scroll-to-top": webOnly("iOS scrolls to the top from the status bar"),
  "search-field": webOnly(
    'a phone searches through the header\'s system search bar or Input type="search"',
  ),
  "secret-input": webOnly(
    "the app signs in through the browser and takes no passwords",
  ),
  "segmented-icon-toggle": webOnly("the app has no icon toggles yet"),
  select: webOnly(
    "a phone picks from a list on its own screen or sheet, not a dropdown",
  ),
  separator: renderer("Separator from @stll/ui/separator", []),
  sheet: renderer("Sheet from @stll/ui/sheet", ["Modal"]),
  sidebar: webOnly(
    "the web's navigation chrome; the app navigates with the platform's tab bar",
  ),
  skeleton: webOnly("the app shows a Loader until content arrives"),
  "split-button": webOnly("the app has no split buttons"),
  "status-mark": webOnly("a web status glyph the app does not show"),
  "stella-mark": webOnly("the app shows the wordmark, not the mark"),
  "stella-wordmark": renderer(
    "StellaWordmarkLatin from @stll/ui/stella-wordmark",
    [],
  ),
  steps: webOnly("the app has no step flows"),
  "swap-text": webOnly("a web text animation"),
  switch: renderer("Switch from @stll/ui/switch", ["Switch"]),
  table: webOnly("a phone lists records in rows, not a table"),
  "table-chart": webOnly("the app draws no charts"),
  tabs: webOnly("a phone switches sections with the platform's tab bar"),
  text: renderer("Text from @stll/ui/text", ["Text"]),
  "text-mark": webOnly("the app highlights no text"),
  textarea: renderer("Textarea from @stll/ui/textarea", [
    "TextInput[multiline]",
  ]),
  toast: webOnly(
    "the app reports outcomes inline; there is no toast host on the phone",
  ),
  "toolbar-icon-action": webOnly(
    "a web toolbar button with a hover tooltip; a phone has no hover",
  ),
  tooltip: webOnly(
    "a phone has no hover; a control's name is its accessibility label",
  ),
  "truncated-text": webOnly(
    "reveals the full text in a hover tooltip; a phone has no hover and caps lines with Text's numberOfLines",
  ),
  "view-toolbar": webOnly(
    "the web's view filter row; the app filters from the header",
  ),
  "workspace-shell": webOnly(
    "the web's page layout; screens lay out with the platform's navigation",
  ),
} as const satisfies Record<ComponentModule, ReactNativeColumn>;

/** The module that marks a component a React Native renderer replaces. */
export const REACT_NATIVE_MODULE = "react-native";

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

/** One generated rule: its module, its replacement, and what it reports. */
export type NativeRuleEntry = {
  module: string;
  use: string;
  /** Web markup, from the row's patterns; empty for a React Native-only rule. */
  patterns: NativePatterns;
  /** React Native components, from the row's React Native column. */
  reactNative: readonly string[];
};

const reactNativeColumn = (module: string): ReactNativeColumn | undefined => {
  const columns: Readonly<Record<string, ReactNativeColumn>> =
    NO_NATIVE_UI_REACT_NATIVE;
  return columns[module];
};

/** The React Native components a module's rule reports, if any. */
const reactNativeReplaced = (module: string): readonly string[] => {
  const column = reactNativeColumn(module);
  return column?.kind === "renderer" ? column.replaces : [];
};

/**
 * The modules that generate a rule: every row of kind "native", and every
 * component whose React Native renderer replaces a React Native component.
 */
export const nativeEntries = (): NativeRuleEntry[] =>
  Object.entries(NO_NATIVE_UI_REGISTRY).flatMap(
    ([module, entry]: [string, NoNativeUiEntry]) => {
      const reactNative = reactNativeReplaced(module);
      const column = reactNativeColumn(module);
      if (entry.kind === "native") {
        return [
          { module, use: entry.use, patterns: entry.patterns, reactNative },
        ];
      }
      return column?.kind === "renderer" && reactNative.length > 0
        ? [{ module, use: column.use, patterns: {}, reactNative }]
        : [];
    },
  );

/** The generated rules a React Native surface enables: its renderers' rules. */
export const reactNativeRuleModules = (): string[] =>
  nativeEntries().flatMap(({ module }) =>
    reactNativeColumn(module)?.kind === "renderer" ? [module] : [],
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
