import type {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_KEYS,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_TARGET_METADATA,
  BrowserControlElementCommand,
  ELEMENT_REFERENCE_SHADOW_SEGMENT,
} from "@stll/api-contract/browser-control";

import type {
  IDENTITY_PROVIDER_HOSTS,
  SIGN_IN_POLICY,
  SignInPolicy,
} from "./sign-in-policy";

/**
 * The one script that runs inside a page: it reads the page (a window of
 * its visible text, find in page, its headings) and acts on it (click,
 * fill, select, key press). It uses the DOM only, never a browser
 * extension API, so any host that can run a function in a page and hand it
 * one argument can use it: Chrome's `scripting.executeScript` here.
 *
 * The host serializes `pageScript` and runs the copy in each frame, so every
 * helper lives inside it and it may reference nothing outside itself; the
 * types below are erased. Element paths and reading positions are
 * frame-local; the host qualifies them with the frame and its document.
 */

export const SNAPSHOT_PURPOSE = {
  read: "read",
  /** Answers `{ refused: "sign-in" }` or `{ refused: "none" }`; reads nothing. */
  signInCheck: "sign-in-check",
} as const;

type SnapshotPurpose = (typeof SNAPSHOT_PURPOSE)[keyof typeof SNAPSHOT_PURPOSE];

/**
 * A place in the reading order of a frame's document. `node` is an element
 * (`text` -1) or the text node at child index `text` of the element at
 * `path`; `phase` says whether the position is where an element opens or
 * closes; `skip` counts characters of the block that starts there already
 * read (a block longer than one window). `fingerprint` must still match the
 * node, or the document changed and the position is refused.
 */
type ReaderNodePosition = {
  fingerprint: string;
  path: string;
  phase: "close" | "open";
  skip: number;
  text: number;
  type: "node";
};

export type ReaderPosition =
  { type: "end" } | { type: "start" } | ReaderNodePosition;

/**
 * Where `find` resumes: in the block element at this place, after its
 * first `offset` matches (0 for a heading, which resumes after it).
 */
type ScanPosition =
  | { type: "start" }
  | {
      fingerprint: string;
      offset: number;
      path: string;
      text: number;
      type: "node";
    };

export type ReadRequest = {
  /** Forward reads from `position`; backward reads the blocks right before it. */
  direction: "backward" | "forward";
  maxChars: number;
  maxControls: number;
  maxLinks: number;
  /** `viewport`: the first block in view when the page is scrolled, else the start. */
  position: ReaderPosition | { type: "viewport" };
};

export type FindRequest =
  | {
      after: ScanPosition;
      countLimit: number;
      maxResults: number;
      query: string;
      snippetChars: number;
      type: "text";
    }
  | {
      after: ScanPosition;
      headingChars: number;
      maxResults: number;
      /** Empty for every heading. */
      query: string;
      type: "headings";
    };

type ReadOnlyOperationBase = {
  /**
   * The origin the tab's top document must have; every frame refuses
   * before reading anything when it is another. Absent reads any page.
   */
  expectedTopOrigin?: string;
  identityProviderHosts: typeof IDENTITY_PROVIDER_HOSTS;
  limits: typeof BROWSER_CONTROL_LIMITS;
  metadataType: typeof BROWSER_CONTROL_TARGET_METADATA;
  shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
  signIn: SignInPolicy;
  signInPolicies: typeof SIGN_IN_POLICY;
};

export type PageOperation =
  | {
      action: BrowserControlElementCommand;
      errorCode: typeof BROWSER_CONTROL_ERROR_CODE;
      /** The frame origin the worker checked; the action refuses any other. */
      expectedOrigin: string;
      identityProviderHosts: typeof IDENTITY_PROVIDER_HOSTS;
      kind: "action";
      limits: typeof BROWSER_CONTROL_LIMITS;
      metadataType: typeof BROWSER_CONTROL_TARGET_METADATA;
      path: string;
      shadowSegment: typeof ELEMENT_REFERENCE_SHADOW_SEGMENT;
      signIn: SignInPolicy;
      /** What the action returns on a document that asks for a sign-in. */
      signInMessage: string;
      signInPolicies: typeof SIGN_IN_POLICY;
    }
  | { kind: "locate" }
  | (ReadOnlyOperationBase & {
      /** The page's canonical link, language and citation meta entries. */
      facts: boolean;
      /** Put between an element id's letter and number: `4.` in frame 4. */
      idPrefix: string;
      kind: "snapshot";
      /** Up to this many of the page's own controls outside the window; 0 for none. */
      pageControls: number;
      /** A read, or only whether the frame asks for a sign-in. */
      purpose: SnapshotPurpose;
      purposes: typeof SNAPSHOT_PURPOSE;
      /** The window to read; absent reads no text. */
      read?: ReadRequest;
    })
  | (ReadOnlyOperationBase & {
      find: FindRequest;
      kind: "find";
    });

export const pageScript = (pageOperation: PageOperation) => {
  if (pageOperation.kind === "locate") {
    return { origin: window.origin, url: window.location.href };
  }
  if (
    pageOperation.kind !== "action" &&
    typeof pageOperation.expectedTopOrigin === "string"
  ) {
    // A frame learns its top document's origin from its own ancestors;
    // when the browser withholds it, the frame refuses as well.
    const ancestors = window.location.ancestorOrigins;
    const topOrigin =
      window === window.top
        ? window.origin
        : ancestors.item(ancestors.length - 1);
    if (topOrigin !== pageOperation.expectedTopOrigin) {
      return { refused: "top-origin" };
    }
  }
  const { limits, metadataType, shadowSegment } = pageOperation;
  const SKIPPED_TAGS = new Set(["NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);
  const normalize = (value: string) => value.replaceAll(/\s+/gu, " ").trim();
  // A select's option by its value, or else by its visible label, case and
  // spacing ignored.
  const optionNamed = (
    options: readonly HTMLOptionElement[],
    named: string,
  ) => {
    const label = (text: string) => normalize(text).toLowerCase();
    return (
      options.find((option) => option.value === named) ??
      options.find((option) => label(option.label) === label(named))
    );
  };
  // A computed style is live: one per element serves the whole run.
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    const cached = styles.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const style = window.getComputedStyle(element);
    styles.set(element, style);
    return style;
  };
  const visible = (element: Element) => {
    const style = styleOf(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      (style.display === "contents" || element.getClientRects().length > 0)
    );
  };
  // `-webkit-text-security` is how pages mask secrets outside
  // type=password; it is inherited, so masked descendants count too.
  const masked = (element: Element) => {
    const security = styleOf(element).getPropertyValue("-webkit-text-security");
    return security !== "" && security !== "none";
  };
  const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
    "current-password",
    "new-password",
    "one-time-code",
  ]);
  // Whole words of a field's name or id that mark it secret: `userPassword`
  // and `one_time_code` count, `hotplate` and `photoprint` do not.
  const SECRET_NAME_WORDS = new Set([
    "csc",
    "cvc",
    "cvv",
    "onetime",
    "otp",
    "passcode",
    "passphrase",
    "passwd",
    "password",
    "pwd",
    "totp",
  ]);
  const nameWords = (identifier: string) =>
    identifier
      .replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .split(/[^a-z\d]+/u)
      .filter((word) => word.length > 0);
  const nameMarksSecret = (identifier: string) => {
    const words = nameWords(identifier);
    return words.some(
      (word, index) =>
        SECRET_NAME_WORDS.has(word) ||
        (word === "one" && words[index + 1] === "time"),
    );
  };
  // Values of secret fields seen in this document. A page can reveal a
  // password by swapping the field for a new element or by printing it;
  // any field holding one, and any text containing one, is withheld.
  // Values shorter than this are too common to match safely.
  const SECRET_VALUE_MIN_CHARS = 4;
  const SECRETS_KEY = "stellaSecretValues";
  const isSecretSet = (value: unknown): value is Set<string> =>
    value instanceof Set;
  const storedSecrets: unknown = Reflect.get(globalThis, SECRETS_KEY);
  const secretValues = isSecretSet(storedSecrets)
    ? storedSecrets
    : new Set<string>();
  Reflect.set(globalThis, SECRETS_KEY, secretValues);
  const REDACTED = "[hidden]";
  const holdsSecret = (text: string) => {
    for (const secret of secretValues) {
      if (text.includes(secret)) {
        return true;
      }
    }
    return false;
  };
  const redact = (text: string) => {
    let redacted = text;
    for (const secret of secretValues) {
      redacted = redacted.replaceAll(secret, () => REDACTED);
    }
    return redacted;
  };
  // A field once seen as secret stays secret for the life of its
  // document, so a "show password" toggle that turns type=password into
  // text does not make the value readable. The extension's isolated world
  // keeps this set across injections; the page can neither see nor clear
  // it.
  const HISTORY_KEY = "stellaSensitiveFields";
  const storedHistory: unknown = Reflect.get(globalThis, HISTORY_KEY);
  const sensitiveHistory: WeakSet<Element> =
    storedHistory instanceof WeakSet ? storedHistory : new WeakSet();
  Reflect.set(globalThis, HISTORY_KEY, sensitiveHistory);
  const isTextField = (
    element: Element,
  ): element is HTMLInputElement | HTMLTextAreaElement =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement;
  const namedLikeSecret = (element: Element) =>
    isTextField(element) &&
    (nameMarksSecret(element.name) || nameMarksSecret(element.id));
  // Passwords, payment cards and one-time codes: their values and text
  // are never read, and the model may not type or choose them.
  const isSensitiveField = (element: Element) => {
    if (sensitiveHistory.has(element)) {
      return true;
    }
    const sensitive =
      (isTextField(element) && holdsSecret(element.value)) ||
      (element instanceof HTMLInputElement && element.type === "password") ||
      (element.getAttribute("autocomplete") ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .some(
          (token) =>
            token.startsWith("cc-") || SENSITIVE_AUTOCOMPLETE_TOKENS.has(token),
        ) ||
      masked(element) ||
      namedLikeSecret(element);
    if (sensitive) {
      sensitiveHistory.add(element);
    }
    return sensitive;
  };
  // Every secret field's current value joins the secrets, whenever it
  // is seen, so a value typed after the first look counts too.
  const rememberSecretValue = (element: Element) => {
    if (
      isTextField(element) &&
      element.value.length >= SECRET_VALUE_MIN_CHARS &&
      isSensitiveField(element)
    ) {
      secretValues.add(element.value);
    }
  };
  // The document's open shadow roots, found while its fields are recorded:
  // the page's own controls are looked up in them too.
  const openShadowRoots: ShadowRoot[] = [];
  // Records every field that is secret right now, before anything reads
  // the page or acts on it.
  const rememberSensitiveFields = (root: ParentNode) => {
    for (const element of root.querySelectorAll("*")) {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        isSensitiveField(element);
        rememberSecretValue(element);
      }
      if (element.shadowRoot) {
        openShadowRoots.push(element.shadowRoot);
        rememberSensitiveFields(element.shadowRoot);
      }
    }
  };
  // Learns the page's secret values and keeps learning them. Runs only
  // once a desktop sign-in refusal is ruled out: a page handed to the
  // member is never read. The watchers it installed earlier go on
  // learning after a sign-in form appears: the values stay in the
  // extension's isolated world and only withhold the same text from
  // every later read, as when a single-page app shows it again.
  const learnSecrets = () => {
    rememberSensitiveFields(document);
    // From the first injection on, secret values are learned as they
    // change, not only when a command looks: a password typed while the
    // user has the tab, then shown by a page that swaps or retypes the
    // field, is still known. Installed once per document, in the
    // extension's isolated world, where the page cannot remove it.
    const WATCH_KEY = "stellaSecretWatch";
    if (Reflect.get(globalThis, WATCH_KEY) !== true) {
      Reflect.set(globalThis, WATCH_KEY, true);
      const learn = (node: unknown) => {
        if (node instanceof Element) {
          rememberSecretValue(node);
        }
      };
      const onEdit = (event: Event) => {
        learn(event.composedPath().at(0));
      };
      document.addEventListener("input", onEdit, true);
      document.addEventListener("change", onEdit, true);
      new MutationObserver((records) => {
        for (const record of records) {
          if (
            record.type === "attributes" &&
            record.attributeName === "type" &&
            record.oldValue?.toLowerCase() === "password" &&
            record.target instanceof Element
          ) {
            sensitiveHistory.add(record.target);
          }
          learn(record.target);
          for (const removed of record.removedNodes) {
            if (removed instanceof Element) {
              learn(removed);
              for (const field of removed.querySelectorAll("input, textarea")) {
                learn(field);
              }
            }
          }
        }
      }).observe(document, {
        attributeFilter: ["autocomplete", "id", "name", "type"],
        attributeOldValue: true,
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
  };
  // A computed CSS length or number, read with the CSS parser: pixels for a
  // length, the value itself for a plain number. NaN for anything else
  // (`auto`, a keyword, a percentage).
  const cssNumber = (text: string): number => {
    try {
      const value = CSSNumericValue.parse(text.trim());
      return value instanceof CSSUnitValue &&
        (value.unit === "px" || value.unit === "number")
        ? value.value
        : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };
  // A rect(...) clip or a clip-path that leaves nothing to see.
  const clippedAway = (style: CSSStyleDeclaration) => {
    // Computed as `rect(top, right, bottom, left)`; `auto` edges read as
    // NaN and never count as collapsed.
    const clip = style.getPropertyValue("clip");
    const edges = clip.startsWith("rect(")
      ? clip.slice("rect(".length, -1).split(",").map(cssNumber)
      : [];
    const [
      top = Number.NaN,
      right = Number.NaN,
      bottom = Number.NaN,
      left = Number.NaN,
    ] = edges;
    if (edges.length === 4 && (right - left <= 1 || bottom - top <= 1)) {
      return true;
    }
    return /^(?:inset\((?:[5-9]\d|\d{3,})%|circle\(0(?:px)?[\s)])/u.test(
      style.clipPath,
    );
  };
  const CLIPPING_OVERFLOW = new Set(["clip", "hidden"]);
  // Content a reader of the rendered page cannot see: hidden from
  // assistive technology, transparent, clipped away, collapsed to a
  // pixel or pushed off the page. Pages hide instructions for AI readers
  // there, so neither its text nor its controls are collected.
  const concealed = (element: Element) =>
    element.getAttribute("aria-hidden") === "true" || concealedByStyle(element);
  const concealedByStyle = (element: Element) => {
    const style = styleOf(element);
    if (style.display === "contents") {
      return false;
    }
    if (cssNumber(style.opacity) === 0 || clippedAway(style)) {
      return true;
    }
    const rect = element.getBoundingClientRect();
    if (
      (CLIPPING_OVERFLOW.has(style.overflowX) && rect.width <= 1) ||
      (CLIPPING_OVERFLOW.has(style.overflowY) && rect.height <= 1)
    ) {
      return true;
    }
    return (
      (rect.width > 0 || rect.height > 0) &&
      (rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0)
    );
  };
  // Text inside a visible box that still does not show: zero-size or
  // transparent glyphs, or text indented off the page.
  const TRANSPARENT_COLORS = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
  const styleConcealsText = (style: CSSStyleDeclaration) =>
    style.fontSize === "0px" ||
    cssNumber(style.textIndent) <= -999 ||
    (TRANSPARENT_COLORS.has(style.color) &&
      style.backgroundClip !== "text" &&
      style.getPropertyValue("-webkit-background-clip") !== "text");
  const concealsText = (element: Element) =>
    styleConcealsText(styleOf(element));
  const concealedCache = new Map<Element, boolean>();
  const concealedInTree = (element: Element): boolean => {
    const cached = concealedCache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const root = element.getRootNode();
    const parent =
      element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    const hidden =
      concealed(element) || (parent !== null && concealedInTree(parent));
    concealedCache.set(element, hidden);
    return hidden;
  };
  const childNodesOf = (element: Element): readonly Node[] => {
    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedNodes({ flatten: true });
      if (assigned.length > 0) {
        return assigned;
      }
    }
    return [...(element.shadowRoot ?? element).childNodes];
  };
  const collectText = (root: Node, maxChars: number) => {
    const parts: string[] = [];
    let total = 0;
    const stack: Node[] = [root];
    while (total < maxChars) {
      const node = stack.pop();
      if (!node) {
        break;
      }
      if (node instanceof Text) {
        const value = (node.nodeValue ?? "").slice(0, maxChars - total);
        if (value.trim().length > 0) {
          parts.push(value);
          total += value.length;
        }
        continue;
      }
      if (
        !(node instanceof Element) ||
        SKIPPED_TAGS.has(node.tagName) ||
        !visible(node) ||
        concealed(node) ||
        concealsText(node) ||
        isSensitiveField(node)
      ) {
        continue;
      }
      const children = childNodesOf(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) {
          stack.push(child);
        }
      }
    }
    return redact(normalize(parts.join(" ")));
  };
  const roleFor = (element: Element) => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    if (element instanceof HTMLAnchorElement) {
      return "link";
    }
    if (element instanceof HTMLButtonElement) {
      return "button";
    }
    if (element instanceof HTMLSelectElement) {
      return "select";
    }
    if (element instanceof HTMLTextAreaElement) {
      return "textbox";
    }
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        return element.type;
      }
      // A search field, or a text field in a search landmark: typing a
      // query there is what a search is.
      return element.type === "search" ||
        element.closest("[role='search'], search") !== null
        ? "searchbox"
        : "textbox";
    }
    return "interactive";
  };
  const isLinkLike = (element: Element) =>
    element instanceof HTMLAnchorElement ||
    element.getAttribute("role") === "link";
  // A link is named by the words a reader sees, which are what a page cites;
  // its aria-label or title names it only when it shows none.
  const shownLinkText = (element: Element) =>
    isLinkLike(element) ? collectText(element, limits.elementNameChars) : "";
  const nameFor = (element: Element) => {
    const shown = shownLinkText(element);
    return redact(
      normalize(
        shown === ""
          ? (element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("placeholder") ??
              collectText(element, limits.elementNameChars))
          : shown,
      ),
    ).slice(0, limits.elementNameChars);
  };
  // A link's aria-label or title beside its visible text, when short and
  // different: often what the link leads to.
  const alternateNameFor = (element: Element) => {
    if (shownLinkText(element) === "") {
      return undefined;
    }
    const other = redact(
      normalize(
        element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          "",
      ),
    );
    return other === "" ||
      other.length > limits.elementAlternateNameChars ||
      other === nameFor(element)
      ? undefined
      : other;
  };
  const valueFor = (element: Element) => {
    if (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) &&
      !isSensitiveField(element)
    ) {
      return element.value.slice(0, limits.valueChars);
    }
    return undefined;
  };
  const hrefFor = (element: Element) =>
    element instanceof HTMLAnchorElement && element.href !== ""
      ? redact(element.href).slice(0, limits.urlChars)
      : undefined;
  const isDisabled = (element: Element) =>
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled") === "true";
  // The row, list item or form around a control: identical controls in
  // repeated rows differ only by this text, so it is part of the identity
  // a later action must match.
  const CONTEXT_SELECTOR =
    "tr, li, [role='row'], [role='listitem'], article, fieldset, form, section";
  const contextFor = (element: Element) => {
    const container = element.closest(CONTEXT_SELECTOR);
    if (!container || container === document.body) {
      return undefined;
    }
    const text = collectText(container, limits.contextChars).slice(
      0,
      limits.contextChars,
    );
    return text.length === 0 || text === nameFor(element) ? undefined : text;
  };
  const metadataFor = (value: string | undefined) =>
    value === undefined
      ? { type: metadataType.absent }
      : { type: metadataType.present, value };
  const focusableSelector =
    "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
  const moveFocus = (element: HTMLElement) => {
    const focusables = [...document.querySelectorAll(focusableSelector)].filter(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        visible(candidate) &&
        !isDisabled(candidate),
    );
    focusables[focusables.indexOf(element) + 1]?.focus();
  };
  const editValue = (element: HTMLElement, edit: (value: string) => string) => {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      return;
    }
    Reflect.set(
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      "value",
      edit(element.value),
      element,
    );
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const stepSelect = (element: HTMLElement, delta: number) => {
    if (!(element instanceof HTMLSelectElement)) {
      return;
    }
    const next = Math.min(
      Math.max(element.selectedIndex + delta, 0),
      element.options.length - 1,
    );
    if (next === element.selectedIndex) {
      return;
    }
    element.selectedIndex = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // Synthetic KeyboardEvents reach page listeners but never trigger the
  // browser's default action, so each supported key performs it here.
  // A total map rather than a switch: this function is serialized into the
  // page, where panic() is unavailable for an exhaustive default.
  const defaultKeyActions: Record<
    (typeof BROWSER_CONTROL_KEYS)[number],
    (element: HTMLElement) => void
  > = {
    ArrowDown: (element) => stepSelect(element, 1),
    ArrowLeft: (element) => stepSelect(element, -1),
    ArrowRight: (element) => stepSelect(element, 1),
    ArrowUp: (element) => stepSelect(element, -1),
    Backspace: (element) => editValue(element, (value) => value.slice(0, -1)),
    Enter: (element) => {
      if (element instanceof HTMLTextAreaElement) {
        editValue(element, (value) => `${value}\n`);
      } else if (element instanceof HTMLInputElement && element.form) {
        element.form.requestSubmit();
      } else if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLAnchorElement
      ) {
        element.click();
      }
    },
    Escape: (element) => element.blur(),
    Space: (element) => {
      if (
        element instanceof HTMLButtonElement ||
        (element instanceof HTMLInputElement &&
          (element.type === "checkbox" || element.type === "radio"))
      ) {
        element.click();
      }
    },
    Tab: (element) => moveFocus(element),
  };
  const performDefaultKeyAction = (
    element: HTMLElement,
    key: (typeof BROWSER_CONTROL_KEYS)[number],
  ) => {
    defaultKeyActions[key](element);
  };
  const pathFor = (element: Element) => {
    const segments: string[] = [];
    let current: Element = element;
    while (current !== document.documentElement) {
      const parent = current.parentElement;
      if (parent) {
        segments.push(
          String(Array.prototype.indexOf.call(parent.children, current)),
        );
        current = parent;
        continue;
      }
      const root = current.parentNode;
      if (!(root instanceof ShadowRoot)) {
        return null;
      }
      segments.push(
        String(Array.prototype.indexOf.call(root.children, current)),
        shadowSegment,
      );
      current = root.host;
    }
    return segments.toReversed().join(".");
  };
  const resolveElement = (path: string): Element | null => {
    let container: Element | ShadowRoot = document.documentElement;
    for (const segment of path.split(".")) {
      if (segment === shadowSegment) {
        if (!(container instanceof Element) || !container.shadowRoot) {
          return null;
        }
        container = container.shadowRoot;
        continue;
      }
      // The child whose index the segment names, as `pathFor` wrote it.
      const next: Element | undefined = [...container.children].find(
        (_child, index) => String(index) === segment,
      );
      if (next === undefined) {
        return null;
      }
      container = next;
    }
    return container instanceof Element ? container : null;
  };

  // A field only the member fills in: a password, a one-time code, or
  // a masked secret. A document showing one is a sign-in, which the
  // member completes; nothing of it is read or acted on.
  const SIGN_IN_NAME_WORDS = new Set([
    "onetime",
    "otp",
    "passcode",
    "passphrase",
    "passwd",
    "password",
    "pwd",
    "totp",
  ]);
  const namedLikeSignIn = (identifier: string) => {
    const words = nameWords(identifier);
    return words.some(
      (word, index) =>
        SIGN_IN_NAME_WORDS.has(word) ||
        (word === "one" && words[index + 1] === "time"),
    );
  };
  const isSignInField = (element: HTMLInputElement | HTMLTextAreaElement) =>
    element.type === "password" ||
    (element.getAttribute("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token)) ||
    masked(element) ||
    namedLikeSignIn(element.name) ||
    namedLikeSignIn(element.id);
  const asksForSignIn = (root: ParentNode): boolean => {
    for (const element of root.querySelectorAll("*")) {
      // A text area counts like an input: a one-time code is typed
      // into either.
      const field =
        (element instanceof HTMLInputElement && element.type !== "hidden") ||
        element instanceof HTMLTextAreaElement
          ? element
          : null;
      if (
        field !== null &&
        isSignInField(field) &&
        visible(field) &&
        !concealedInTree(field)
      ) {
        return true;
      }
      if (element.shadowRoot && asksForSignIn(element.shadowRoot)) {
        return true;
      }
    }
    return false;
  };

  // Under the desktop policy a sign-in is refused before anything is
  // read or done; a web connection reads on with secrets withheld.
  const signInRefusal = () => {
    if (pageOperation.signIn !== pageOperation.signInPolicies.handToMember) {
      return null;
    }
    // An identity provider's page, here a frame the worker's address
    // check of the top document does not see, is the member's whatever
    // fields it shows (matched as `isIdentityProviderUrl` does).
    const host = URL.parse(window.location.href)?.hostname.toLowerCase() ?? "";
    const onIdentityProvider = pageOperation.identityProviderHosts.some(
      (pattern) =>
        pattern.startsWith(".")
          ? host.endsWith(pattern) && host.length > pattern.length
          : host === pattern,
    );
    const asks = onIdentityProvider || asksForSignIn(document);
    if (
      pageOperation.kind === "snapshot" &&
      pageOperation.purpose === pageOperation.purposes.signInCheck
    ) {
      return { refused: asks ? "sign-in" : "none" } as const;
    }
    if (!asks) {
      return null;
    }
    return pageOperation.kind !== "action"
      ? ({ refused: "sign-in" } as const)
      : ({
          code: pageOperation.errorCode.needsMember,
          error: pageOperation.signInMessage,
          ok: false,
        } as const);
  };
  const refusedSignIn = signInRefusal();
  if (refusedSignIn !== null) {
    return refusedSignIn;
  }
  learnSecrets();

  // What the page offers to act on. Links are listed where they are read;
  // the page's own controls are listed whatever part of it is read.
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='button']",
    "[role='checkbox']",
    "[role='combobox']",
    "[role='link']",
    "[role='menuitem']",
    "[role='radio']",
    "[role='tab']",
    "[role='textbox']",
  ].join(",");

  // Reading: a window of the text, find, the headings. Everything it
  // defines is local to it, and it touches only what it reads.
  const readPage = (
    operation: Extract<PageOperation, { kind: "find" | "snapshot" }>,
  ) => {
    const pageControlSelector = [
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[role='checkbox']",
      "[role='combobox']",
      "[role='menuitem']",
      "[role='radio']",
      "[role='searchbox']",
      "[role='tab']",
      "[role='textbox']",
    ].join(",");
    const textOf = (node: Node) => node.textContent ?? "";

    // Element ids. A link or control keeps the number it was first given
    // for the life of its document, whatever window shows it, so an id an
    // agent read always names the same element. The numbers live in the
    // extension's isolated world, which the page can neither see nor
    // change; the host prefixes a subframe's with the frame's id.
    const ID_KEY = "stellaElementIds";
    type IdRegistry = {
      controls: WeakMap<Element, number>;
      links: WeakMap<Element, number>;
      next: { control: number; link: number };
    };
    const isIdRegistry = (value: unknown): value is IdRegistry =>
      typeof value === "object" &&
      value !== null &&
      "controls" in value &&
      value.controls instanceof WeakMap &&
      "links" in value &&
      value.links instanceof WeakMap &&
      "next" in value &&
      typeof value.next === "object" &&
      value.next !== null &&
      "control" in value.next &&
      typeof value.next.control === "number" &&
      "link" in value.next &&
      typeof value.next.link === "number";
    const storedIds: unknown = Reflect.get(globalThis, ID_KEY);
    const ids: IdRegistry = isIdRegistry(storedIds)
      ? storedIds
      : {
          controls: new WeakMap(),
          links: new WeakMap(),
          next: { control: 1, link: 1 },
        };
    Reflect.set(globalThis, ID_KEY, ids);
    const idPrefix = operation.kind === "snapshot" ? operation.idPrefix : "";
    const idOf = (element: Element, kind: "control" | "link") => {
      const numbers = kind === "link" ? ids.links : ids.controls;
      let number = numbers.get(element);
      if (number === undefined) {
        if (kind === "link") {
          number = ids.next.link;
          ids.next.link = number + 1;
        } else {
          number = ids.next.control;
          ids.next.control = number + 1;
        }
        numbers.set(element, number);
      }
      return `${kind === "link" ? "L" : "E"}${idPrefix}${String(number)}`;
    };
    const elementView = (element: Element, kind: "control" | "link") => {
      const path = pathFor(element);
      if (path === null) {
        return null;
      }
      const alternateName = alternateNameFor(element);
      const value = valueFor(element);
      return {
        ...(alternateName === undefined ? {} : { alternateName }),
        context: metadataFor(contextFor(element)),
        href: metadataFor(hrefFor(element)),
        id: idOf(element, kind),
        name: nameFor(element),
        path,
        role: roleFor(element),
        ...(value === undefined ? {} : { value }),
      };
    };

    // ---- The reading order -------------------------------------------
    //
    // The reader walks the document from a place, forward or backward,
    // and touches only what it reads: a window costs the nodes in it, not
    // the page. Text is cut into blocks at block-level tags (by tag, so no
    // style is read to find them) and at `<br>`; inline elements join
    // their text as the page prints it. A place is an element's open or
    // close edge, or a text node.
    const root = document.querySelector("body") ?? document.documentElement;
    const BLOCK_TAGS = new Set([
      "ADDRESS",
      "ARTICLE",
      "ASIDE",
      "BLOCKQUOTE",
      "BODY",
      "CAPTION",
      "CENTER",
      "DD",
      "DETAILS",
      "DIALOG",
      "DIV",
      "DL",
      "DT",
      "FIELDSET",
      "FIGCAPTION",
      "FIGURE",
      "FOOTER",
      "FORM",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "HEADER",
      "HGROUP",
      "HR",
      "LEGEND",
      "LI",
      "MAIN",
      "MENU",
      "NAV",
      "OL",
      "P",
      "PRE",
      "SECTION",
      "SUMMARY",
      "TABLE",
      "TBODY",
      "TFOOT",
      "THEAD",
      "TR",
      "UL",
    ]);
    const BLOCK_SELECTOR = [...BLOCK_TAGS]
      .map((tag) => tag.toLowerCase())
      .join(", ");
    const HEADING_LEVELS = new Map([
      ["H1", 1],
      ["H2", 2],
      ["H3", 3],
      ["H4", 4],
      ["H5", 5],
      ["H6", 6],
    ]);
    const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role='heading']";
    // Elements whose content is not page text: a control's value, an
    // embedded document, media.
    const UNREAD_TAGS = new Set([
      "AUDIO",
      "CANVAS",
      "EMBED",
      "IFRAME",
      "OBJECT",
      "SELECT",
      "TEXTAREA",
      "VIDEO",
    ]);
    // A margin or paragraph number: short, a number or a roman numeral,
    // perhaps in brackets.
    const MARKER_TEXT = /^[([]?(?:\d{1,4}[a-z]?|[clivx]{1,6})[).:\]]?$/iu;
    const HEADING_MAX_CHARS = 160;
    const HEADING_MIN_LETTERS = 3;
    // Stands for a link's marker until the window numbers its links; the
    // page's own text never carries it.
    const LINK_MARK = String.fromCodePoint(0xe0_00);
    /** Characters a marker takes at most: ` [L1234567.1234567]`. */
    const LINK_MARK_COST = 20;
    /** `::before` or `::after` text kept: enough for "§ " and list labels. */
    const GENERATED_TEXT_CHARS = 16;
    /** Places a probe of the surroundings looks at before it gives up. */
    const PROBE_LIMIT = 5000;

    // A number printed beside a paragraph but hidden from assistive
    // technology is still on the page, and a reader cites it.
    const printedMarker = (element: Element) =>
      MARKER_TEXT.test(textOf(element).trim());
    const readableElements = new Map<Element, boolean>();
    const readable = (element: Element): boolean => {
      const cached = readableElements.get(element);
      if (cached !== undefined) {
        return cached;
      }
      const result =
        !SKIPPED_TAGS.has(element.tagName) &&
        visible(element) &&
        !concealsText(element) &&
        !isSensitiveField(element) &&
        !concealedByStyle(element) &&
        (element.getAttribute("aria-hidden") !== "true" ||
          printedMarker(element));
      readableElements.set(element, result);
      return result;
    };
    const descends = (element: Element) =>
      !UNREAD_TAGS.has(element.tagName) && element.tagName !== "BR";

    // The tree as the page renders it: an element with an open shadow root
    // shows that root's content, a slot shows the nodes assigned to it (or
    // its own content when none are), anything else its children. A host's
    // children that no slot takes are not rendered and never reached.
    // Closed shadow roots stay unread.
    const slotted = (element: Element): readonly Node[] | null => {
      if (!(element instanceof HTMLSlotElement)) {
        return null;
      }
      const assigned = element.assignedNodes();
      return assigned.length > 0 ? assigned : null;
    };
    const firstRendered = (element: Element): Node | null =>
      element.shadowRoot === null
        ? (slotted(element)?.at(0) ?? element.firstChild)
        : element.shadowRoot.firstChild;
    const lastRendered = (element: Element): Node | null =>
      element.shadowRoot === null
        ? (slotted(element)?.at(-1) ?? element.lastChild)
        : element.shadowRoot.lastChild;
    const slotOf = (node: Node): HTMLSlotElement | null =>
      node instanceof Element || node instanceof Text
        ? node.assignedSlot
        : null;
    const renderedSibling = (node: Node, step: -1 | 1): Node | null => {
      const slot = slotOf(node);
      if (slot === null) {
        return step === 1 ? node.nextSibling : node.previousSibling;
      }
      const assigned = slot.assignedNodes();
      return assigned[assigned.indexOf(node) + step] ?? null;
    };
    // The element a node is rendered in; null for one that is not rendered
    // (a host's child no slot takes) or for the document's body.
    const renderedParent = (node: Node): Element | null => {
      if (node === root) {
        return null;
      }
      const slot = slotOf(node);
      if (slot !== null) {
        return slot;
      }
      const parent = node.parentNode;
      if (parent instanceof ShadowRoot) {
        return parent.host;
      }
      return parent instanceof Element && parent.shadowRoot === null
        ? parent
        : null;
    };
    // Whether `inner` is rendered inside `outer`, across shadow roots.
    const renderedWithin = (outer: Node, inner: Node) => {
      for (
        let current: Node | null = inner;
        current !== null;
        current = renderedParent(current)
      ) {
        if (current === outer) {
          return true;
        }
      }
      return false;
    };

    // The block element a node is rendered in, across shadow roots; the
    // body when there is none.
    const renderedBlockOf = (node: Node): Element => {
      for (
        let current: Node | null = node;
        current !== null;
        current = renderedParent(current)
      ) {
        if (current instanceof Element && BLOCK_TAGS.has(current.tagName)) {
          return current;
        }
      }
      return root;
    };

    type Place = { node: Node; phase: "close" | "open" };
    const following = (node: Node): Place | null => {
      if (node === root) {
        return null;
      }
      const sibling = renderedSibling(node, 1);
      if (sibling !== null) {
        return { node: sibling, phase: "open" };
      }
      const parent = renderedParent(node);
      return parent === null ? null : { node: parent, phase: "close" };
    };
    const nextPlace = ({ node, phase }: Place): Place | null => {
      if (phase === "open" && node instanceof Element && readable(node)) {
        const first = descends(node) ? firstRendered(node) : null;
        return first === null
          ? { node, phase: "close" }
          : { node: first, phase: "open" };
      }
      return following(node);
    };
    const lastPlaceIn = (node: Node): Place =>
      node instanceof Element && readable(node)
        ? { node, phase: "close" }
        : { node, phase: "open" };
    const previousPlace = ({ node, phase }: Place): Place | null => {
      if (phase === "close" && node instanceof Element) {
        const last = descends(node) ? lastRendered(node) : null;
        return last === null ? { node, phase: "open" } : lastPlaceIn(last);
      }
      if (node === root) {
        return null;
      }
      const sibling = renderedSibling(node, -1);
      if (sibling !== null) {
        return lastPlaceIn(sibling);
      }
      const parent = renderedParent(node);
      return parent === null ? null : { node: parent, phase: "open" };
    };

    type Break = {
      edge: "close" | "line" | "open";
      element: Element;
      kind: "break";
    };
    type Item =
      | Break
      | { element: Element; kind: "control"; place: Place }
      /** Where a link's words end: its marker goes here. */
      | { element: Element; kind: "link"; place: Place }
      | { kind: "text"; parent: Element | null; place: Place; value: string };

    // Whether a pseudo-element's own style hides what it draws: the same
    // rules the page's elements are held to. Its box cannot be measured,
    // so one taken out of the flow (absolute or fixed) counts as hidden.
    const pseudoConcealed = (style: CSSStyleDeclaration) =>
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.position === "absolute" ||
      style.position === "fixed" ||
      cssNumber(style.opacity) === 0 ||
      clippedAway(style) ||
      styleConcealsText(style);
    const generatedOf = new WeakMap<Element, Map<string, string>>();
    // `::before` and `::after` text the page prints from plain strings,
    // short as markers and labels are: counters and attributes are left
    // out (their values cannot be read back), and so are icon-font code
    // points and text the pseudo-element's own style hides. Nothing is
    // generated inside a number hidden from assistive technology.
    const generatedText = (
      element: Element,
      pseudo: "::after" | "::before",
    ) => {
      const known = generatedOf.get(element)?.get(pseudo);
      if (known !== undefined) {
        return known;
      }
      const style = window.getComputedStyle(element, pseudo);
      const { content } = style;
      const text =
        element.closest("[aria-hidden='true']") !== null ||
        !/^(?:\s*"(?:[^"\\]|\\.)*")+\s*$/su.test(content) ||
        pseudoConcealed(style)
          ? ""
          : [...content.matchAll(/"((?:[^"\\]|\\.)*)"/gsu)]
              .map(([, quoted = ""]) =>
                // A code point escape is a control or private character
                // in a computed value: it reads as a space.
                quoted.replaceAll(
                  /\\[\da-f]{1,6}\s?|\\(.)/gisu,
                  (_escape: string, literal?: string) => literal ?? " ",
                ),
              )
              .join("")
              .replaceAll(/\p{Co}/gu, "")
              .slice(0, GENERATED_TEXT_CHARS);
      const forElement = generatedOf.get(element) ?? new Map<string, string>();
      forElement.set(pseudo, text);
      generatedOf.set(element, forElement);
      return text;
    };
    const ROMAN_DIGITS = [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ] as const;
    const roman = (value: number) => {
      let rest = value;
      let digits = "";
      for (const [amount, digit] of ROMAN_DIGITS) {
        while (rest >= amount) {
          digits += digit;
          rest -= amount;
        }
      }
      return digits;
    };
    const alphabetic = (value: number) => {
      let rest = value;
      let letters = "";
      while (rest > 0) {
        rest -= 1;
        letters = String.fromCodePoint(97 + (rest % 26)) + letters;
        rest = Math.floor(rest / 26);
      }
      return letters;
    };
    // A list item's number in its list's style; decimal for any other.
    const listLabel = (value: number, type: string) => {
      if (value <= 0 || value > 3999) {
        return String(value);
      }
      switch (type) {
        case "lower-roman":
          return roman(value);
        case "upper-roman":
          return roman(value).toUpperCase();
        case "lower-alpha":
        case "lower-latin":
          return alphabetic(value);
        case "upper-alpha":
        case "upper-latin":
          return alphabetic(value).toUpperCase();
        default:
          return String(value);
      }
    };
    const listNumbers = new Map<Element, Map<Element, number>>();
    const numberInList = (item: Element, list: HTMLOListElement) => {
      const known = listNumbers.get(list);
      if (known !== undefined) {
        return known.get(item) ?? 1;
      }
      const numbers = new Map<Element, number>();
      const items = [...list.children].filter(
        (child): child is HTMLLIElement => child instanceof HTMLLIElement,
      );
      const firstNumber = list.reversed ? items.length : 1;
      let next = list.hasAttribute("start") ? list.start : firstNumber;
      for (const entry of items) {
        if (entry.hasAttribute("value")) {
          next = entry.value;
        }
        numbers.set(entry, next);
        next += list.reversed ? -1 : 1;
      }
      listNumbers.set(list, numbers);
      return numbers.get(item) ?? 1;
    };
    // The marker the browser draws for a list item, rebuilt from the list:
    // its number in the list's style, or a dash for a bullet.
    const listMarker = (item: Element) => {
      const style = styleOf(item);
      if (style.display !== "list-item" || style.listStyleType === "none") {
        return "";
      }
      const list = item.parentElement;
      if (!(list instanceof HTMLOListElement)) {
        return "- ";
      }
      const value = numberInList(item, list);
      return `${listLabel(value, style.listStyleType)}. `;
    };
    const isLink = (element: Element) =>
      element instanceof HTMLAnchorElement &&
      element.hasAttribute("href") &&
      !isDisabled(element);
    const isControl = (element: Element) =>
      !isLink(element) &&
      element.matches(interactiveSelector) &&
      !isDisabled(element);
    const cleanText = (value: string) => value.replaceAll(LINK_MARK, "");

    const itemsAt = (place: Place): Item[] => {
      const { node, phase } = place;
      if (node instanceof Text) {
        return [
          {
            kind: "text",
            parent: node.parentElement,
            place,
            value: cleanText(node.data),
          },
        ];
      }
      if (!(node instanceof Element)) {
        return [];
      }
      if (node.tagName === "BR") {
        return phase === "open"
          ? [{ edge: "line", element: node, kind: "break" }]
          : [];
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (!readable(node)) {
        return block ? [{ edge: "line", element: node, kind: "break" }] : [];
      }
      const items: Item[] = [];
      const atom = (value: string) => {
        if (value === "") {
          return;
        }
        items.push({
          kind: "text",
          parent: node,
          place,
          value: cleanText(value),
        });
      };
      if (phase === "close") {
        const after = generatedText(node, "::after");
        if (after !== "") {
          atom(after);
        }
        if (isLink(node)) {
          items.push({ element: node, kind: "link", place });
        }
        if (block) {
          items.push({ edge: "close", element: node, kind: "break" });
        }
        return items;
      }
      if (block) {
        items.push({ edge: "open", element: node, kind: "break" });
      }
      if (node.tagName === "LI") {
        atom(listMarker(node));
      }
      if (
        (node.tagName === "TD" || node.tagName === "TH") &&
        node.previousElementSibling !== null
      ) {
        atom(" | ");
      }
      if (isControl(node)) {
        items.push({ element: node, kind: "control", place });
      }
      atom(generatedText(node, "::before"));
      if (node.tagName === "SUP" && textOf(node).trim().length <= 6) {
        atom("^");
      }
      return items;
    };
    const isContent = (item: Item) =>
      item.kind === "link" ||
      (item.kind === "text" && item.value.trim() !== "");

    /**
     * Walks from `start` in `direction` and hands `visit` each block's
     * items in document order with the breaks around it (null where the
     * walk began). Stops when `visit` returns false, or after `end`.
     */
    const walkBlocks = (
      start: Place | null,
      direction: "backward" | "forward",
      visit: (
        items: readonly Item[],
        low: Break | null,
        high: Break | null,
      ) => boolean,
      end?: Place,
    ) => {
      let gathered: Item[] = [];
      let edge: Break | null = null;
      const step = (place: Place): Place | null => {
        if (
          end !== undefined &&
          place.node === end.node &&
          place.phase === end.phase
        ) {
          return null;
        }
        return direction === "forward"
          ? nextPlace(place)
          : previousPlace(place);
      };
      for (let place = start; place !== null; place = step(place)) {
        const atPlace = itemsAt(place);
        const items = direction === "forward" ? atPlace : atPlace.toReversed();
        for (const item of items) {
          if (item.kind !== "break") {
            gathered.push(item);
            continue;
          }
          const going =
            direction === "forward"
              ? visit(gathered, edge, item)
              : visit(gathered.toReversed(), item, edge);
          if (!going) {
            return;
          }
          gathered = [];
          edge = item;
        }
      }
      if (direction === "forward") {
        visit(gathered, edge, null);
      } else {
        visit(gathered.toReversed(), null, edge);
      }
    };

    type Block = {
      controls: Element[];
      first: Place | null;
      last: Place | null;
      links: Element[];
      /** The element around the block's first printed words. */
      parent: Element | null;
      /** Whitespace collapsed as the page prints it; `LINK_MARK` after each link. */
      text: string;
    };
    const buildBlock = (items: readonly Item[]): Block => {
      const block: Block = {
        controls: [],
        first: null,
        last: null,
        links: [],
        parent: null,
        text: "",
      };
      for (const item of items) {
        if (item.kind === "break") {
          continue;
        }
        block.first ??= item.place;
        block.last = item.place;
        if (item.kind === "control") {
          block.controls.push(item.element);
          continue;
        }
        if (item.kind === "link") {
          block.links.push(item.element);
          block.text += LINK_MARK;
          continue;
        }
        if (block.parent === null && item.value.trim() !== "") {
          block.parent = item.parent;
        }
        let addition = item.value.replaceAll(/\s+/gu, " ");
        if (
          addition.startsWith(" ") &&
          (block.text === "" || block.text.endsWith(" "))
        ) {
          addition = addition.slice(1);
        }
        block.text += addition;
      }
      block.text = redact(block.text.trimEnd());
      return block;
    };

    // ---- Headings ----------------------------------------------------
    //
    // One rule marks headings in the text and lists them for an outline:
    // a heading tag or role (its level from the tag or `aria-level`), or a
    // block element of its own (no block or `<br>` inside it) whose text
    // is 3 to 160 characters with at least 3 letters and is printed bold
    // (weight 600 or more: level 4) or larger than the page's base size
    // (1.2 times: level 3, 1.5 times: level 2).
    const ARIA_LEVELS = new Map([
      ["1", 1],
      ["2", 2],
      ["3", 3],
      ["4", 4],
      ["5", 5],
      ["6", 6],
    ]);
    const baseFontSize = { value: 0 };
    const pageFontSize = () => {
      if (baseFontSize.value === 0) {
        const size = cssNumber(styleOf(root).fontSize);
        baseFontSize.value = Number.isFinite(size) && size > 0 ? size : 16;
      }
      return baseFontSize.value;
    };
    const taggedHeadingLevel = (element: Element | null): number => {
      const heading = element?.closest(HEADING_SELECTOR) ?? null;
      if (heading === null || !renderedWithin(root, heading)) {
        return 0;
      }
      const level = HEADING_LEVELS.get(heading.tagName);
      if (level !== undefined) {
        return level;
      }
      return ARIA_LEVELS.get(heading.getAttribute("aria-level") ?? "") ?? 2;
    };
    const headingLevelOf = (element: Element): number => {
      if (
        HEADING_LEVELS.has(element.tagName) ||
        element.getAttribute("role") === "heading"
      ) {
        return taggedHeadingLevel(element);
      }
      // Inside a tagged heading the heading is the tagged one.
      if (
        (element.parentElement?.closest(HEADING_SELECTOR) ?? null) !== null ||
        !BLOCK_TAGS.has(element.tagName) ||
        element.querySelector(`${BLOCK_SELECTOR}, br`) !== null
      ) {
        return 0;
      }
      const text = normalize(textOf(element));
      if (
        text.length > HEADING_MAX_CHARS ||
        (text.match(/\p{L}/gu) ?? []).length < HEADING_MIN_LETTERS
      ) {
        return 0;
      }
      // Bold set on the one element that wraps all of the text counts too.
      const wrapper =
        element.children.length === 1 &&
        [...element.childNodes].every(
          (child) => !(child instanceof Text) || child.data.trim() === "",
        )
          ? element.children.item(0)
          : null;
      const style = styleOf(wrapper ?? element);
      const size = cssNumber(style.fontSize);
      const base = pageFontSize();
      if (size >= base * 1.5) {
        return 2;
      }
      if (size >= base * 1.2) {
        return 3;
      }
      return cssNumber(style.fontWeight) >= 600 ? 4 : 0;
    };
    // A block is the element's own when the walk opened and closed it
    // around nothing but the block.
    const blockLevel = (
      block: Block,
      low: Break | null,
      high: Break | null,
    ): number => {
      const tagged = taggedHeadingLevel(block.parent);
      if (tagged > 0) {
        return tagged;
      }
      return low?.edge === "open" &&
        high?.edge === "close" &&
        low.element === high.element
        ? headingLevelOf(low.element)
        : 0;
    };
    // The break right before `place` when only blank text lies between.
    const breakBefore = (place: Place): Break | null => {
      let steps = 0;
      for (
        let current = previousPlace(place);
        current !== null && steps < PROBE_LIMIT;
        current = previousPlace(current)
      ) {
        steps += 1;
        for (const item of itemsAt(current).toReversed()) {
          if (item.kind === "break") {
            return item;
          }
          if (isContent(item)) {
            return null;
          }
        }
      }
      return null;
    };
    const contentBefore = (place: Place): boolean => {
      let steps = 0;
      for (
        let current = previousPlace(place);
        current !== null;
        current = previousPlace(current)
      ) {
        steps += 1;
        if (steps > PROBE_LIMIT || itemsAt(current).some(isContent)) {
          return true;
        }
      }
      return false;
    };
    const contentFrom = (place: Place): boolean => {
      let steps = 0;
      for (
        let current: Place | null = place;
        current !== null;
        current = nextPlace(current)
      ) {
        steps += 1;
        if (steps > PROBE_LIMIT || itemsAt(current).some(isContent)) {
          return true;
        }
      }
      return false;
    };
    // Where the block around `place` starts: its first item after the
    // break before it.
    const blockStartOf = (place: Place): Place => {
      let start = place;
      let steps = 0;
      for (
        let current = previousPlace(place);
        current !== null && steps < PROBE_LIMIT;
        current = previousPlace(current)
      ) {
        steps += 1;
        const items = itemsAt(current);
        const lastBreak = items.findLastIndex((item) => item.kind === "break");
        if (lastBreak !== -1) {
          return lastBreak < items.length - 1 ? current : start;
        }
        if (items.length > 0) {
          start = current;
        }
      }
      return start;
    };

    // ---- Positions the host turns into cursors -------------------------
    const FINGERPRINT_BLOCK_CHARS = 96;
    // The first words of the block around a node, read only as far as
    // needed: what tells one paragraph's "1" from another's.
    const blockSample = (node: Node) => {
      const walker = document.createTreeWalker(
        renderedBlockOf(node),
        NodeFilter.SHOW_TEXT,
      );
      let sample = "";
      for (
        let text = walker.nextNode();
        text !== null && sample.length < FINGERPRINT_BLOCK_CHARS;
        text = walker.nextNode()
      ) {
        // Indentation between tags says nothing about the content.
        const value = textOf(text);
        if (value.trim() !== "") {
          sample += value;
        }
      }
      return sample.slice(0, FINGERPRINT_BLOCK_CHARS);
    };
    // Changes when the node at a path is no longer the one a position was
    // issued for: its own text and its block's first words.
    const fingerprintOf = (node: Node) => {
      const own =
        node instanceof Element
          ? `${node.tagName}:${
              node.firstChild instanceof Text
                ? node.firstChild.data.slice(0, 64)
                : (node.firstElementChild?.tagName ?? "")
            }`
          : textOf(node).slice(0, 64);
      const sample = `${own}|${blockSample(node)}`;
      let hash = 7;
      for (let index = 0; index < sample.length; index += 1) {
        hash = (hash * 31 + (sample.codePointAt(index) ?? 0)) % 2_147_483_647;
      }
      return hash.toString(36);
    };
    // An element by its path; a text node by its container's path and its
    // index there. A text node right inside a shadow root has the host's
    // path with the shadow segment after it.
    const nodeAddress = (node: Node) => {
      if (node instanceof Element) {
        const path = pathFor(node);
        return path === null
          ? null
          : { fingerprint: fingerprintOf(node), path, text: -1 };
      }
      const container = node.parentNode;
      let path: string | null = null;
      if (container instanceof Element) {
        path = pathFor(container);
      } else if (container instanceof ShadowRoot) {
        const hostPath = pathFor(container.host);
        path = hostPath === null ? null : `${hostPath}.${shadowSegment}`;
      }
      return container === null || path === null
        ? null
        : {
            fingerprint: fingerprintOf(node),
            path,
            text: Array.prototype.indexOf.call(container.childNodes, node),
          };
    };
    const positionOf = (place: Place, skip: number) => {
      if (place.node === root && skip === 0) {
        return place.phase === "open"
          ? ({ type: "start" } as const)
          : ({ type: "end" } as const);
      }
      const address = nodeAddress(place.node);
      return address === null
        ? null
        : { ...address, phase: place.phase, skip, type: "node" as const };
    };
    const scanPositionOf = (node: Node, offset: number) => {
      const address = nodeAddress(node);
      return address === null
        ? null
        : { ...address, offset, type: "node" as const };
    };
    // Whether every element around `node`, up to the document's body, is
    // one the reader reads.
    // Whether every element `node` is rendered in, up to the document's
    // body and across shadow roots, is one the reader reads. False for a
    // node that is not rendered at all.
    const ancestorsReadable = (node: Node) => {
      for (
        let parent = renderedParent(node);
        parent !== null;
        parent = renderedParent(parent)
      ) {
        if (!readable(parent)) {
          return false;
        }
        if (parent === root) {
          return true;
        }
      }
      return node === root;
    };
    // The one rule for where a read may start, whatever chose the place (a
    // cursor, the address's fragment, the point in view): rendered inside
    // the body, and nowhere the page hides.
    const startAllowed = (node: Node) => ancestorsReadable(node);
    const SHADOW_SUFFIX = `.${shadowSegment}`;
    const addressed = (address: {
      fingerprint: string;
      path: string;
      text: number;
    }): Node | null => {
      const inShadow = address.path.endsWith(SHADOW_SUFFIX);
      const element = resolveElement(
        inShadow ? address.path.slice(0, -SHADOW_SUFFIX.length) : address.path,
      );
      const container = inShadow ? (element?.shadowRoot ?? null) : element;
      let node: Node | null = null;
      if (address.text >= 0) {
        node = container?.childNodes.item(address.text) ?? null;
      } else if (!inShadow) {
        node = element;
      }
      if (
        node === null ||
        (address.text >= 0 && !(node instanceof Text)) ||
        fingerprintOf(node) !== address.fingerprint
      ) {
        return null;
      }
      return startAllowed(node) ? node : null;
    };
    const placeOf = (
      position:
        | { type: "end" }
        | { type: "start" }
        | {
            fingerprint: string;
            path: string;
            phase: "close" | "open";
            text: number;
            type: "node";
          },
    ): Place | null => {
      if (position.type === "start") {
        return { node: root, phase: "open" };
      }
      if (position.type === "end") {
        return { node: root, phase: "close" };
      }
      const node = addressed(position);
      if (
        node === null ||
        (position.phase === "close" &&
          !(node instanceof Element && readable(node)))
      ) {
        return null;
      }
      return { node, phase: position.phase };
    };

    // ---- Where a default read starts ---------------------------------
    const pinnedToViewport = (element: Element) => {
      for (
        let current: Element | null = element;
        current !== null;
        current = current.parentElement
      ) {
        const { position } = styleOf(current);
        if (position === "fixed" || position === "sticky") {
          return true;
        }
      }
      return false;
    };
    const scrolledInto = (element: Element) => {
      for (
        let current: Element | null = element;
        current !== null;
        current = current.parentElement
      ) {
        if (current.scrollTop > 0) {
          return true;
        }
      }
      return window.scrollY > 0;
    };
    // The element the address's fragment names, when it is in view: the
    // section a link landed on.
    const anchorTarget = () => {
      const fragment = window.location.hash.slice(1);
      if (fragment === "") {
        return null;
      }
      let id = fragment;
      try {
        id = decodeURIComponent(fragment);
      } catch {
        // A fragment that is not valid percent-encoding names itself.
      }
      const target =
        document.querySelector(`#${CSS.escape(id)}`) ??
        document.querySelector(`[name="${CSS.escape(id)}"]`);
      if (target === null || !startAllowed(target)) {
        return null;
      }
      return Math.abs(target.getBoundingClientRect().top) <= window.innerHeight
        ? target
        : null;
    };
    const VIEWPORT_PROBES = [
      [0.5, 0.02],
      [0.3, 0.02],
      [0.5, 0.15],
      [0.3, 0.15],
      [0.7, 0.15],
      [0.5, 0.3],
      [0.5, 0.45],
    ] as const;
    // The first block in view on a scrolled page; the document's start
    // when it is not scrolled.
    const viewportStart = (): Place => {
      const target = anchorTarget();
      if (target !== null) {
        return blockStartOf({ node: target, phase: "open" });
      }
      for (const [across, down] of VIEWPORT_PROBES) {
        const caret = document.caretPositionFromPoint(
          window.innerWidth * across,
          window.innerHeight * down,
        );
        const node = caret?.offsetNode ?? null;
        const element =
          node instanceof Element ? node : (node?.parentElement ?? null);
        if (
          node === null ||
          element === null ||
          !renderedWithin(root, node) ||
          pinnedToViewport(element)
        ) {
          continue;
        }
        if (!scrolledInto(element)) {
          break;
        }
        if (startAllowed(node)) {
          return blockStartOf({ node, phase: "open" });
        }
      }
      return { node: root, phase: "open" };
    };

    // ---- Windows ------------------------------------------------------
    type ReadBlock = {
      first: Place;
      last: Place;
      level: number;
      links: Element[];
      text: string;
    };
    type Span = {
      blocks: ReadBlock[];
      controls: Element[];
      /** Where the next window starts. */
      end: { place: Place; skip: number } | null;
      hasAfter: boolean;
      hasBefore: boolean;
      start: { place: Place; skip: number };
    };
    const marksIn = (text: string) => text.split(LINK_MARK).length - 1;
    const costOf = (text: string) =>
      text.length + marksIn(text) * (LINK_MARK_COST - 1);
    const lineOf = (text: string, level: number) =>
      level > 0 ? `${"#".repeat(level)} ${text}` : text;
    // The longest head of `text` that fits `room`, cut at a space when one
    // is near: where the part ends and where the rest resumes.
    const cutPoint = (text: string, room: number): [number, number] => {
      let cost = 0;
      let index = 0;
      while (index < text.length) {
        const next =
          cost + (text.charAt(index) === LINK_MARK ? LINK_MARK_COST : 1);
        if (next > room) {
          break;
        }
        cost = next;
        index += 1;
      }
      if (index >= text.length) {
        return [text.length, text.length];
      }
      const space = text.lastIndexOf(" ", index);
      if (space > index / 2) {
        return [space, space + 1];
      }
      const hard = Math.max(index, 1);
      return [hard, hard];
    };
    // Where the longest tail of `text` that fits `room` starts.
    const tailPoint = (text: string, room: number): number => {
      let cost = 0;
      let index = text.length;
      while (index > 0) {
        const next =
          cost + (text.charAt(index - 1) === LINK_MARK ? LINK_MARK_COST : 1);
        if (next > room) {
          break;
        }
        cost = next;
        index -= 1;
      }
      if (index === 0) {
        return 0;
      }
      const space = text.indexOf(" ", index);
      return space !== -1 && space - index < (text.length - index) / 2
        ? space + 1
        : Math.min(index, text.length - 1);
    };

    const readForward = (start: Place, skip: number, budget: number): Span => {
      const blocks: ReadBlock[] = [];
      const controls: Element[] = [];
      const state: {
        end: Span["end"];
        first: Span["start"] | null;
        pendingSkip: number;
        used: number;
      } = { end: null, first: null, pendingSkip: skip, used: 0 };
      walkBlocks(start, "forward", (items, low, high) => {
        const block = buildBlock(items);
        if (block.first === null || block.last === null) {
          return true;
        }
        const offset = Math.min(state.pendingSkip, block.text.length);
        const resumed = state.pendingSkip > 0 && block.text !== "";
        if (block.text !== "") {
          state.pendingSkip = 0;
        }
        const text = block.text.slice(offset);
        const links = block.links.slice(marksIn(block.text.slice(0, offset)));
        // A resumed block's controls went with its first part.
        const blockControls = resumed ? [] : block.controls;
        if (text === "") {
          controls.push(...blockControls);
          return true;
        }
        const level = blockLevel(block, low ?? breakBefore(block.first), high);
        const fixed = costOf(lineOf("", level)) + 1;
        const read: ReadBlock = {
          first: block.first,
          last: block.last,
          level,
          links,
          text,
        };
        if (state.used + fixed + costOf(text) <= budget) {
          blocks.push(read);
          controls.push(...blockControls);
          state.used += fixed + costOf(text);
          state.first ??= { place: block.first, skip: offset };
          return true;
        }
        if (blocks.length > 0) {
          state.end = { place: block.first, skip: offset };
          return false;
        }
        // One block longer than a window: as much as fits, then the rest.
        const [partEnd, resume] = cutPoint(text, Math.max(1, budget - fixed));
        const part = text.slice(0, partEnd);
        blocks.push({
          ...read,
          links: links.slice(0, marksIn(part)),
          text: part,
        });
        controls.push(...blockControls);
        state.first = { place: block.first, skip: offset };
        state.end = { place: block.first, skip: offset + resume };
        return false;
      });
      const first = state.first ?? { place: start, skip };
      return {
        blocks,
        controls,
        end: state.end,
        hasAfter: state.end !== null,
        hasBefore: first.skip > 0 || contentBefore(first.place),
        start: first,
      };
    };

    const readBackward = (
      target: Place,
      skip: number,
      budget: number,
    ): Span => {
      const blocks: ReadBlock[] = [];
      const controls: Element[][] = [];
      const state: {
        more: boolean;
        start: Span["start"] | null;
        used: number;
      } = { more: false, start: null, used: 0 };
      const accept = (read: ReadBlock, blockControls: Element[]): boolean => {
        const fixed = costOf(lineOf("", read.level)) + 1;
        if (state.used + fixed + costOf(read.text) <= budget) {
          blocks.unshift(read);
          controls.unshift(blockControls);
          state.used += fixed + costOf(read.text);
          state.start = { place: read.first, skip: 0 };
          return true;
        }
        state.more = true;
        if (blocks.length > 0) {
          return false;
        }
        const from = tailPoint(read.text, Math.max(1, budget - fixed));
        blocks.unshift({
          ...read,
          links: read.links.slice(marksIn(read.text.slice(0, from))),
          text: read.text.slice(from),
        });
        state.start = { place: read.first, skip: from };
        return false;
      };
      const flow = { going: true };
      if (skip > 0) {
        // The head of the block at `target`, which the later window read
        // from its middle.
        walkBlocks(target, "forward", (items, low, high) => {
          const block = buildBlock(items);
          if (
            block.first === null ||
            block.last === null ||
            block.text === ""
          ) {
            return true;
          }
          const text = block.text.slice(0, skip);
          flow.going = accept(
            {
              first: block.first,
              last: block.last,
              level: blockLevel(block, low ?? breakBefore(block.first), high),
              links: block.links.slice(0, marksIn(text)),
              text,
            },
            block.controls,
          );
          return false;
        });
      }
      if (flow.going) {
        walkBlocks(previousPlace(target), "backward", (items, low, high) => {
          const block = buildBlock(items);
          if (block.first === null || block.last === null) {
            return true;
          }
          if (block.text === "") {
            controls.unshift(block.controls);
            return true;
          }
          return accept(
            {
              first: block.first,
              last: block.last,
              level: blockLevel(block, low, high),
              links: block.links,
              text: block.text,
            },
            block.controls,
          );
        });
      }
      return {
        blocks,
        controls: controls.flat(),
        end: { place: target, skip },
        hasAfter: skip > 0 || contentFrom(target),
        hasBefore: state.more,
        start: state.start ?? { place: target, skip },
      };
    };

    const pageHeight = () =>
      Math.max(document.documentElement.scrollHeight, root.scrollHeight, 1);
    const percentAt = (place: Place, edge: "bottom" | "top") => {
      const element =
        place.node instanceof Element ? place.node : place.node.parentElement;
      if (element === null) {
        return 0;
      }
      const rect = element.getBoundingClientRect();
      const y = (edge === "top" ? rect.top : rect.bottom) + window.scrollY;
      return Math.min(100, Math.max(0, Math.round((100 * y) / pageHeight())));
    };

    const readWindow = (request: ReadRequest) => {
      const { position } = request;
      const start =
        position.type === "viewport" ? viewportStart() : placeOf(position);
      if (start === null) {
        return null;
      }
      const skip = position.type === "node" ? position.skip : 0;
      const span =
        request.direction === "backward" && position.type !== "viewport"
          ? readBackward(start, skip, request.maxChars)
          : readForward(start, skip, request.maxChars);
      const links: NonNullable<ReturnType<typeof elementView>>[] = [];
      const linkCount = { leftOut: false };
      const lines = span.blocks.map((block) => {
        let index = 0;
        return lineOf(block.text, block.level).replaceAll(
          LINK_MARK,
          (_mark: string, offset: number, line: string) => {
            const element = block.links[index];
            index += 1;
            const view =
              element === undefined || links.length >= request.maxLinks
                ? null
                : elementView(element, "link");
            if (view === null) {
              linkCount.leftOut = true;
              return "";
            }
            links.push(view);
            const spaced = offset === 0 || line.charAt(offset - 1) === " ";
            return `${spaced ? "" : " "}[${view.id}]`;
          },
        );
      });
      const windowControls = [...new Set(span.controls)];
      const controls = windowControls
        .slice(0, request.maxControls)
        .flatMap((element) => {
          const view = elementView(element, "control");
          return view === null ? [] : [view];
        });
      const lastBlock = span.blocks.at(-1);
      return {
        controlElements: windowControls,
        result: {
          controls,
          controlsLeftOut: windowControls.length > request.maxControls,
          end:
            (span.end === null
              ? null
              : positionOf(span.end.place, span.end.skip)) ??
            ({ type: "end" } as const),
          fromPercent: percentAt(span.start.place, "top"),
          hasAfter: span.hasAfter,
          hasBefore: span.hasBefore,
          links,
          linksLeftOut: linkCount.leftOut,
          start:
            positionOf(span.start.place, span.start.skip) ??
            ({ type: "start" } as const),
          text: lines.join("\n"),
          toPercent: percentAt(lastBlock?.last ?? span.start.place, "bottom"),
        },
      };
    };

    // ---- The page's own controls and facts ---------------------------
    const pageControlsOf = (max: number, excluded: ReadonlySet<Element>) => {
      if (max <= 0) {
        return { controls: [], leftOut: false };
      }
      const candidates = [document, ...openShadowRoots]
        .flatMap((scope) => [...scope.querySelectorAll(pageControlSelector)])
        .filter((element) => !excluded.has(element));
      // A search field first: it is how a page is searched.
      const ordered = [
        ...candidates.filter((element) => roleFor(element) === "searchbox"),
        ...candidates.filter((element) => roleFor(element) !== "searchbox"),
      ];
      const controls: NonNullable<ReturnType<typeof elementView>>[] = [];
      // Bounded: a page with thousands of hidden filter options is not
      // style-checked through all of them.
      const checkLimit = max * 6;
      let checked = 0;
      for (const element of ordered) {
        if (controls.length >= max || checked >= checkLimit) {
          return { controls, leftOut: true };
        }
        checked += 1;
        if (
          visible(element) &&
          !isDisabled(element) &&
          !concealedInTree(element)
        ) {
          const view = elementView(element, "control");
          if (view !== null) {
            controls.push(view);
          }
        }
      }
      return { controls, leftOut: false };
    };
    // Meta entries that identify a work for citing (title, author, dates,
    // publisher, address); descriptions and keywords are text the page
    // never shows, so they stay out.
    const CITATION_META =
      /^(?:article:(?:author|modified_time|published_time)|author|citation_\w+|date|dc\.[\w.]+|dcterms\.[\w.]+|last-modified|og:(?:site_name|title|updated_time|url)|publisher)$/iu;
    const factsOf = () => {
      const canonical = document.querySelector("link[rel~='canonical'][href]");
      const canonicalUrl =
        canonical instanceof HTMLLinkElement && canonical.href !== ""
          ? redact(canonical.href).slice(0, limits.urlChars)
          : "";
      const language = document.documentElement.lang.trim().slice(0, 35);
      const meta: { name: string; value: string }[] = [];
      for (const entry of document.querySelectorAll(
        "meta[name], meta[property]",
      )) {
        if (meta.length >= limits.pageMetaEntries) {
          break;
        }
        const name = (
          entry.getAttribute("name") ??
          entry.getAttribute("property") ??
          ""
        ).trim();
        const value = normalize(entry.getAttribute("content") ?? "");
        if (CITATION_META.test(name) && value !== "") {
          meta.push({
            name: name.slice(0, limits.pageMetaNameChars),
            value: redact(value).slice(0, limits.pageMetaValueChars),
          });
        }
      }
      return {
        ...(canonicalUrl === "" ? {} : { canonicalUrl }),
        ...(language === "" ? {} : { language }),
        meta,
      };
    };

    // ---- Find ---------------------------------------------------------
    //
    // Find searches the text the reader returns, block by block, and
    // nothing else: hidden text never matches, and a match never runs
    // across two blocks. Matching ignores case and diacritics and lets any
    // run of spaces match any run of spaces. The page's own text (and its
    // open shadow roots) only says which blocks to read: a block is a
    // candidate when the query's longest word occurs in it, so text a page
    // draws only with CSS is found together with words of its own text.
    //
    // Folding keeps one code unit for one: lower case, and a letter's base
    // letter where it has one of the same length.
    const BASE_LETTERS = new Map([
      ["đ", "d"],
      ["ħ", "h"],
      ["ı", "i"],
      ["ŀ", "l"],
      ["ł", "l"],
      ["ø", "o"],
      ["ŧ", "t"],
    ]);
    const foldedChars = new Map<string, string>();
    const foldChar = (char: string) => {
      const cached = foldedChars.get(char);
      if (cached !== undefined) {
        return cached;
      }
      const lower = char.toLowerCase();
      // oxlint-disable-next-line no-direct-unicode-normalize/no-direct-unicode-normalize -- the page script runs serialized inside the page and cannot import @stll/text-normalize; it needs the base letter of one character, length kept.
      const base = lower.normalize("NFD").replaceAll(/\p{M}/gu, "");
      const candidate = BASE_LETTERS.get(base) ?? base;
      // Only a fold of the same length that lower-casing leaves alone:
      // anything else would move every offset after it.
      const folded =
        candidate.length === char.length &&
        candidate.toLowerCase() === candidate
          ? candidate
          : String.fromCodePoint(0xff_fd).repeat(char.length);
      foldedChars.set(char, folded);
      return folded;
    };
    // Each non-ASCII character is folded once and cached; ASCII is lower-
    // cased by the engine, which keeps its length.
    const fold = (text: string) =>
      text.replaceAll(/[^\p{ASCII}]/gu, foldChar).toLowerCase();
    const wordsOf = (query: string) =>
      fold(query)
        .split(/\s+/u)
        .filter((word) => word !== "");
    const SPACE = /\s/u;
    // Where `words` occur in `text` from `from` on, with any run of spaces
    // between them: [start, end), or null.
    const matchFrom = (
      text: string,
      words: readonly string[],
      from: number,
    ): [number, number] | null => {
      const [head, ...rest] = words;
      if (head === undefined) {
        return null;
      }
      for (
        let start = text.indexOf(head, from);
        start !== -1;
        start = text.indexOf(head, start + 1)
      ) {
        let end = start + head.length;
        let matched = true;
        for (const word of rest) {
          let next = end;
          while (next < text.length && SPACE.test(text.charAt(next))) {
            next += 1;
          }
          if (next === end || !text.startsWith(word, next)) {
            matched = false;
            break;
          }
          end = next + word.length;
        }
        if (matched) {
          return [start, end];
        }
      }
      return null;
    };
    // The reader's blocks inside `element`, as a window would print them.
    const blocksWithin = (element: Element): Block[] => {
      if (!readable(element) || !ancestorsReadable(element)) {
        return [];
      }
      const blocks: Block[] = [];
      walkBlocks(
        { node: element, phase: "open" },
        "forward",
        (items) => {
          const block = buildBlock(items);
          if (block.first !== null && block.text !== "") {
            blocks.push(block);
          }
          return true;
        },
        { node: element, phase: "close" },
      );
      return blocks;
    };
    // Whether `later` comes after `earlier` in the document.
    const follows = (earlier: Node, later: Node) => {
      const position = earlier.compareDocumentPosition(later);
      return (
        position === Node.DOCUMENT_POSITION_FOLLOWING ||
        position ===
          Node.DOCUMENT_POSITION_FOLLOWING + Node.DOCUMENT_POSITION_CONTAINED_BY
      );
    };
    // Rendered reading order, across shadow roots: negative when `left`
    // comes first. Within the document tree the browser's own order
    // answers; across shadow roots, the rendered ancestors are compared.
    const childIndexes = new Map<Element, Map<Node, number>>();
    const renderedIndex = (parent: Element, child: Node) => {
      let indexes = childIndexes.get(parent);
      if (indexes === undefined) {
        const children =
          parent.shadowRoot === null
            ? [...(slotted(parent) ?? parent.childNodes)]
            : [...parent.shadowRoot.childNodes];
        indexes = new Map(children.map((node, index) => [node, index]));
        childIndexes.set(parent, indexes);
      }
      return indexes.get(child) ?? -1;
    };
    const renderedOrder = (left: Node, right: Node): number => {
      if (left === right) {
        return 0;
      }
      // Within one tree, and outside slots, the browser's order is the
      // rendered one.
      if (
        left.getRootNode() === right.getRootNode() &&
        slotOf(left) === null &&
        slotOf(right) === null
      ) {
        return follows(left, right) ? -1 : 1;
      }
      const chainOf = (node: Node) => {
        const chain: Node[] = [];
        for (
          let current: Node | null = node;
          current !== null;
          current = renderedParent(current)
        ) {
          chain.push(current);
        }
        return chain.toReversed();
      };
      const leftChain = chainOf(left);
      const rightChain = chainOf(right);
      let index = 0;
      while (
        index < leftChain.length &&
        index < rightChain.length &&
        leftChain[index] === rightChain[index]
      ) {
        index += 1;
      }
      const parent = leftChain[index - 1];
      const leftChild = leftChain[index];
      const rightChild = rightChain[index];
      if (leftChild === undefined) {
        return -1;
      }
      if (rightChild === undefined || !(parent instanceof Element)) {
        return 1;
      }
      return (
        renderedIndex(parent, leftChild) - renderedIndex(parent, rightChild)
      );
    };
    // Adds the block of each text node in `scope` (the body, or an open
    // shadow root) that holds `word`. Script and style text is never read,
    // so it names no block.
    const addCandidates = (scope: Node, word: string, found: Set<Element>) => {
      const folded = fold(textOf(scope));
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let nodeStart = 0;
      for (
        let index = folded.indexOf(word);
        index !== -1 && node !== null;
        index = folded.indexOf(word, index + word.length)
      ) {
        while (node !== null && index >= nodeStart + textOf(node).length) {
          nodeStart += textOf(node).length;
          node = walker.nextNode();
        }
        const parent = node?.parentElement ?? null;
        if (
          node !== null &&
          (parent === null ||
            !(
              SKIPPED_TAGS.has(parent.tagName) ||
              UNREAD_TAGS.has(parent.tagName)
            ))
        ) {
          found.add(renderedBlockOf(node));
        }
      }
    };
    // The block elements whose text holds `word`, in rendered order, none
    // inside another.
    const candidateBlocks = (word: string): Element[] => {
      const found = new Set<Element>();
      addCandidates(root, word, found);
      for (const shadowRoot of openShadowRoots) {
        addCandidates(shadowRoot, word, found);
      }
      const outermost: Element[] = [];
      for (const element of [...found].toSorted(renderedOrder)) {
        // In rendered order, a block inside another comes right after it.
        const kept = outermost.at(-1);
        if (kept === undefined || !renderedWithin(kept, element)) {
          outermost.push(element);
        }
      }
      return outermost;
    };
    const scanStart = (
      after:
        | {
            fingerprint: string;
            offset: number;
            path: string;
            text: number;
            type: "node";
          }
        | { type: "start" },
    ) => (after.type === "start" ? { node: null } : { node: addressed(after) });
    const snippetAround = (
      text: string,
      [start, end]: [number, number],
      limit: number,
    ) => {
      const from = Math.max(
        0,
        start - Math.max(0, Math.floor((limit - (end - start)) / 2)),
      );
      return text.slice(from, from + limit);
    };
    const findText = (request: Extract<FindRequest, { type: "text" }>) => {
      const words = wordsOf(request.query);
      const longest = words.toSorted(
        (left, right) => right.length - left.length,
      )[0];
      if (request.countLimit <= 0 || longest === undefined) {
        return { matches: [], total: 0, totalCapped: false };
      }
      const after = scanStart(request.after);
      if (after.node === null && request.after.type === "node") {
        return null;
      }
      const resumeAt = after.node instanceof Element ? after.node : null;
      // A find resumes in the block it stopped in, past what it returned.
      const blocks = [
        ...(resumeAt === null ? [] : [resumeAt]),
        ...candidateBlocks(longest).filter(
          (element) =>
            resumeAt === null ||
            (!renderedWithin(resumeAt, element) &&
              renderedOrder(resumeAt, element) < 0),
        ),
      ];
      const matches: {
        position: NonNullable<ReturnType<typeof positionOf>>;
        snippet: string;
      }[] = [];
      const counted = { capped: false, total: 0 };
      let last: { element: Element; seen: number } | null = null;
      for (const element of blocks) {
        let seen = 0;
        const skip =
          element === resumeAt && request.after.type === "node"
            ? request.after.offset
            : 0;
        for (const block of blocksWithin(element)) {
          const text = cleanText(block.text);
          const folded = fold(text);
          const place = block.first;
          if (place === null) {
            continue;
          }
          for (
            let match = matchFrom(folded, words, 0);
            match !== null;
            match = matchFrom(folded, words, match[1])
          ) {
            seen += 1;
            if (seen <= skip) {
              continue;
            }
            if (counted.total >= request.countLimit) {
              counted.capped = true;
              break;
            }
            counted.total += 1;
            const position = positionOf(place, 0);
            if (matches.length < request.maxResults && position !== null) {
              matches.push({
                position,
                snippet: snippetAround(text, match, request.snippetChars),
              });
              last = { element, seen };
            }
          }
          if (counted.capped) {
            break;
          }
        }
        if (counted.capped) {
          break;
        }
      }
      const lastPosition =
        last === null ? null : scanPositionOf(last.element, last.seen);
      return {
        ...(lastPosition === null ? {} : { last: lastPosition }),
        matches,
        total: counted.total,
        totalCapped: counted.capped,
      };
    };
    const findHeadings = (
      request: Extract<FindRequest, { type: "headings" }>,
    ) => {
      const words = wordsOf(request.query);
      const after = scanStart(request.after);
      if (after.node === null && request.after.type === "node") {
        return null;
      }
      // The next node in rendered order, into shadow roots and slots: into
      // `node`'s own content unless `skipContent`.
      const nextRendered = (node: Node, skipContent: boolean): Node | null => {
        if (
          !skipContent &&
          node instanceof Element &&
          !SKIPPED_TAGS.has(node.tagName) &&
          !UNREAD_TAGS.has(node.tagName)
        ) {
          const child = firstRendered(node);
          if (child !== null) {
            return child;
          }
        }
        for (
          let current: Node | null = node;
          current !== null && current !== root;
          current = renderedParent(current)
        ) {
          const sibling = renderedSibling(current, 1);
          if (sibling !== null) {
            return sibling;
          }
        }
        return null;
      };
      const headings: {
        level: number;
        position: NonNullable<ReturnType<typeof positionOf>>;
        text: string;
      }[] = [];
      let last: Node | null = after.node;
      // A heading's own content is never a heading of its own: after one,
      // the walk goes on past its content.
      let skipContent: boolean;
      for (
        let node =
          after.node === null
            ? firstRendered(root)
            : nextRendered(after.node, true);
        node !== null;
        node = nextRendered(node, skipContent)
      ) {
        skipContent = false;
        if (!(node instanceof Element)) {
          continue;
        }
        const level = headingLevelOf(node);
        if (level === 0) {
          continue;
        }
        skipContent = true;
        const text = blocksWithin(node)
          .map((block) => cleanText(block.text))
          .join(" ")
          .slice(0, request.headingChars);
        const position = positionOf({ node, phase: "open" }, 0);
        if (
          text === "" ||
          position === null ||
          (words.length > 0 && matchFrom(fold(text), words, 0) === null)
        ) {
          continue;
        }
        if (headings.length >= request.maxResults) {
          // One more heading exists: the outline goes on after the last.
          const more = last === null ? null : scanPositionOf(last, 0);
          return { headings, ...(more === null ? {} : { more }) };
        }
        headings.push({ level, position, text });
        last = node;
      }
      return { headings };
    };

    const page = {
      origin: window.origin,
      title: redact(document.title).slice(0, limits.titleChars),
      url: window.location.href.slice(0, limits.urlChars),
    };
    if (operation.kind === "find") {
      const { find } = operation;
      if (find.type === "text") {
        const found = findText(find);
        return found === null
          ? { refused: "stale-cursor" }
          : { ...page, found: { ...found, type: find.type } };
      }
      const found = findHeadings(find);
      return found === null
        ? { refused: "stale-cursor" }
        : { ...page, found: { ...found, type: find.type } };
    }

    const { read } = operation;
    const windowRead = read === undefined ? undefined : readWindow(read);
    if (windowRead === null) {
      return { refused: "stale-cursor" };
    }
    const ownControls = pageControlsOf(
      operation.pageControls,
      new Set(windowRead?.controlElements),
    );
    return {
      ...page,
      ...(operation.facts ? { facts: factsOf() } : {}),
      pageControls: ownControls.controls,
      pageControlsLeftOut: ownControls.leftOut,
      ...(windowRead === undefined ? {} : { window: windowRead.result }),
    };
  };
  if (pageOperation.kind !== "action") {
    return readPage(pageOperation);
  }

  const { action, errorCode } = pageOperation;
  if (window.origin !== pageOperation.expectedOrigin) {
    return {
      code: errorCode.staleSnapshot,
      error: "The frame navigated after the page snapshot.",
      ok: false,
    };
  }
  const target = resolveElement(pageOperation.path);
  if (!target) {
    return {
      error: "The referenced element is no longer on the page.",
      code: errorCode.elementNotFound,
      ok: false,
    };
  }
  // Why the element can no longer take the action; null when it still
  // matches the snapshot and accepts it.
  const targetMetadataMatches = (
    expected:
      | { type: typeof metadataType.absent }
      | { type: typeof metadataType.present; value: string },
    current: string | undefined,
  ) =>
    // Two kinds only; the page script cannot import panic() for a default.
    "value" in expected ? current === expected.value : current === undefined;
  const targetRefusal = (element: Element) => {
    if (
      nameFor(element) !== action.target.name ||
      roleFor(element) !== action.target.role ||
      !targetMetadataMatches(action.target.href, hrefFor(element)) ||
      !targetMetadataMatches(action.target.context, contextFor(element))
    ) {
      return {
        error: "The referenced element changed after the page snapshot.",
        code: errorCode.staleSnapshot,
        ok: false,
      } as const;
    }
    if (!visible(element) || concealedInTree(element)) {
      return {
        error: "The referenced element is no longer visible on the page.",
        code: errorCode.staleSnapshot,
        ok: false,
      } as const;
    }
    if (isDisabled(element)) {
      return {
        code: errorCode.executionFailed,
        error: "The control is disabled; the page does not accept this action.",
        ok: false,
      } as const;
    }
    return null;
  };
  const refusal = targetRefusal(target);
  if (refusal !== null) {
    return refusal;
  }
  const sensitiveFieldRefusal = {
    code: errorCode.sensitiveField,
    error:
      "Passwords, payment card details and one-time codes must be entered manually.",
    ok: false,
  } as const;
  const isSensitiveTarget = isSensitiveField(target);

  if (action.action === "click") {
    if (!(target instanceof HTMLElement)) {
      return {
        error: "The referenced element cannot be clicked.",
        code: errorCode.elementNotFound,
        ok: false,
      };
    }
    target.click();
    return { ok: true };
  }

  if (action.action === "fill") {
    if (target instanceof HTMLInputElement) {
      if (target.type === "file") {
        return {
          code: errorCode.executionFailed,
          error: "File inputs are not supported.",
          ok: false,
        };
      }
      if (isSensitiveTarget) {
        return sensitiveFieldRefusal;
      }
      Reflect.set(HTMLInputElement.prototype, "value", action.value, target);
    } else if (isSensitiveTarget) {
      return sensitiveFieldRefusal;
    } else if (target instanceof HTMLTextAreaElement) {
      Reflect.set(HTMLTextAreaElement.prototype, "value", action.value, target);
    } else if (target instanceof HTMLElement && target.isContentEditable) {
      target.textContent = action.value;
    } else {
      return {
        error: "The referenced element is not editable.",
        code: errorCode.elementNotFound,
        ok: false,
      };
    }
    target.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  if (action.action === "select") {
    if (!(target instanceof HTMLSelectElement)) {
      return {
        error: "The referenced element is not a select control.",
        code: errorCode.elementNotFound,
        ok: false,
      };
    }
    if (isSensitiveTarget) {
      return sensitiveFieldRefusal;
    }
    // `:disabled` also covers an option inside a disabled group.
    const options = [...target.options].filter((option) => !isDisabled(option));
    const chosen = optionNamed(options, action.value);
    if (chosen === undefined) {
      // Labels are page text: redacted as every read redacts it.
      return {
        code: errorCode.executionFailed,
        error: `The select has no option with this label or value. Its options: ${options
          .map((option) => JSON.stringify(redact(normalize(option.label))))
          .join(", ")}`,
        ok: false,
      };
    }
    target.selectedIndex = chosen.index;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  if (!(target instanceof HTMLElement)) {
    return {
      error: "The referenced element cannot receive a key.",
      code: errorCode.elementNotFound,
      ok: false,
    };
  }
  if (isSensitiveTarget) {
    return sensitiveFieldRefusal;
  }
  target.focus();
  const key = action.key === "Space" ? " " : action.key;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  performDefaultKeyAction(target, action.key);
  target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  return { ok: true };
};
