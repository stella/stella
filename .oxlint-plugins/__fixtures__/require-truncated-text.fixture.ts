// Passive regression fixture for `require-truncated-text/require-truncated-text`.

const cn = (...parts: string[]): string => parts.join(" ");

// oxlint-disable-next-line require-truncated-text/require-truncated-text -- fixture proves `truncate` is rejected
const truncated = "truncate text-sm";
// oxlint-disable-next-line require-truncated-text/require-truncated-text -- fixture proves a line clamp is rejected
const clamped = "line-clamp-2 text-xs";
// oxlint-disable-next-line require-truncated-text/require-truncated-text -- fixture proves `text-ellipsis` is rejected
const ellipsis = "overflow-hidden text-ellipsis whitespace-nowrap";
// oxlint-disable-next-line require-truncated-text/require-truncated-text -- fixture proves a variant prefix does not hide the utility
const childSelector = "[&>span]:truncate sm:line-clamp-[7]";
// oxlint-disable-next-line require-truncated-text/require-truncated-text -- fixture proves template elements receive the same guard
const template = `flex truncate`;
// oxlint-disable-next-line require-truncated-text/require-truncated-text -- x2: fixture proves class-composer arguments receive the same guard
const composed = cn("truncate", "line-clamp-3");

const unclamped =
  // expect-clean: require-truncated-text/require-truncated-text
  "line-clamp-none text-clip overflow-hidden";

export {
  childSelector,
  clamped,
  composed,
  ellipsis,
  template,
  truncated,
  unclamped,
};
