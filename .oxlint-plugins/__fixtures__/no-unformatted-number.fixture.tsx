// Passive regression fixture for
// `no-unformatted-number/no-unformatted-number`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// a regression makes them unused and CI fails. Lines without a directive
// cover the allow-list and must keep passing.

declare const x: {
  count: number;
  totalAmount: number;
  name: string;
  items: unknown[];
};
declare function getFormatter(): { number: (n: number) => string };

// --- Flagged: a number reaching the DOM without the formatter ---
export const _strCall = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <span>{String(x.count)}</span>
);
export const _template = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <div>{`${x.totalAmount} items`}</div>
);
export const _bare = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <span>{x.count}</span>
);
export const _length = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <span>{x.items.length}</span>
);
export const _bareWithSibling = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <span>{x.count} left</span>
);
export const _bareInFragment = () => (
  // oxlint-disable-next-line no-unformatted-number/no-unformatted-number
  <>{x.count} left</>
);

// --- Allowed: formatted, non-numeric, or a non-display attribute ---
export const _formatted = () => <span>{getFormatter().number(x.count)}</span>;
export const _nonNumeric = () => <span>{x.name}</span>;
export const _nonDisplayAttr = () => <li key={String(x.count)}>ok</li>;
