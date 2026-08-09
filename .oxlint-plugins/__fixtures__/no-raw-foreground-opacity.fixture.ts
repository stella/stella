// Passive regression fixture for
// `no-raw-foreground-opacity/no-raw-foreground-opacity`.

// oxlint-disable-next-line no-raw-foreground-opacity/no-raw-foreground-opacity -- fixture proves literal foreground opacity utilities are rejected
const rawLiteral = "hover:text-foreground/80";
// oxlint-disable-next-line no-raw-foreground-opacity/no-raw-foreground-opacity -- fixture proves template elements receive the same token guard
const rawTemplate = `placeholder:text-muted-foreground/64`;

const namedLiteral = "text-foreground-muted";
const namedTemplate = `placeholder:text-foreground-placeholder`;
const unrelatedOpacity = "bg-primary/50";

export {
  namedLiteral,
  namedTemplate,
  rawLiteral,
  rawTemplate,
  unrelatedOpacity,
};
