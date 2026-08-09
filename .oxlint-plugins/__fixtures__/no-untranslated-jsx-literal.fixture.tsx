// Passive regression fixture for no-untranslated-jsx-literal.

declare const t: (key: string) => string;

export const RawCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: user-facing JSX text must be translated
  <button type="button">Save matter</button>
);

export const RawExpressionCopy = () => (
  // oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- fixture: string expression children are user-facing too
  <p>{"Unable to continue"}</p>
);

export const TranslatedCopy = () => (
  <button type="button">{t("common.save")}</button>
);
export const TechnicalCopy = () => <code>workspaceId</code>;
export const SymbolCopy = () => <span>•</span>;
