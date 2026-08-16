// Passive regression fixture for
// `no-omitted-prop-respread/no-omitted-prop-respread`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import type * as React from "react";

type PanelProps = React.ComponentProps<"section"> & {
  orientation?: "horizontal" | "vertical";
  variant?: "solid" | "underline";
};

const Panel = (props: PanelProps) => <section {...props} />;

type ShellProps = Omit<PanelProps, "orientation">;
type LabelledShellProps = ShellProps & { label?: string };

const child = <span />;
const VERTICAL = "vertical" as const;

// --- Flagged: the omitted key cannot survive the props spread ---

// Written before the spread, so the spread overwrites it.
export const _pinnedBefore = (props: Omit<PanelProps, "orientation">) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel orientation="horizontal" {...props} />
);

// Never written, so the spread supplies whatever the caller's wider value
// carried.
export const _neverPinned = ({ ...props }: Omit<PanelProps, "variant">) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// Both omitted keys are reported; `variant` is pinned before the spread and
// `orientation` is not pinned at all.
export const _multipleKeys = (
  props: Omit<PanelProps, "orientation" | "variant">,
) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel variant="underline" {...props} />
);

// A second spread after the pin can override it just as the first would.
export const _lastSpreadWins = ({
  ...props
}: Omit<PanelProps, "orientation">) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} orientation="horizontal" {...props} />
);

// The omit is reached through a file-local alias.
export const _viaAlias = ({ ...props }: ShellProps) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// And through an alias that intersects the omitting one.
export const _viaIntersectedAlias = ({
  label: _label,
  ...props
}: LabelledShellProps) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// The shape the portable inspector shell shipped with before the fix: forced
// chrome props sat above the spread that could replace them.
export const _inspectorTabsBeforeFix = ({
  className,
  ...props
}: Omit<PanelProps, "orientation">) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel className={className} orientation="horizontal" {...props} />
);

// --- Allowed: the pin clears the last spread ---

// The shape the portable inspector shell ships today.
export const _ok_inspectorTabs = ({
  className,
  ...props
}: Omit<PanelProps, "orientation">) => (
  <Panel className={className} {...props} orientation="horizontal" />
);
export const _ok_pinnedAfter = (props: Omit<PanelProps, "variant">) => (
  <Panel {...props} variant="underline" />
);
export const _ok_pinnedAfterEveryKey = (
  props: Omit<PanelProps, "orientation" | "variant">,
) => <Panel {...props} orientation="horizontal" variant="underline" />;

// Allowed: nothing is spread, so no wider value reaches the element.
export const _ok_noSpread = ({ id }: Omit<PanelProps, "orientation">) => (
  <Panel id={id} />
);

// Allowed: the spread is not the omitting component's props binding.
export const _ok_unrelatedSpread = (props: Omit<PanelProps, "orientation">) => (
  <Panel {...{ id: props.id }} />
);

// Allowed: a non-literal key set is outside what this rule can read.
export const _ok_genericKeys = <Key extends keyof PanelProps>(
  props: Omit<PanelProps, Key>,
) => <Panel {...props} />;

// Allowed: JSX children are passed positionally and beat a spread `children`.
export const _ok_children = (props: Omit<PanelProps, "children">) => (
  <Panel {...props}>{child}</Panel>
);

// Allowed: the props type omits nothing.
export const _ok_noOmit = (props: PanelProps) => <Panel {...props} />;

// Allowed: the pattern destructures the omitted key, so the rest object
// provably does not carry it and the pin before the spread survives.
export const _ok_destructuredOut = ({
  orientation,
  ...props
}: Omit<PanelProps, "orientation"> & { orientation?: "horizontal" }) => (
  <Panel orientation={orientation} {...props} />
);

// Allowed: the omission re-types the key rather than forbidding it, so it is
// meant to reach the element through the spread.
export const _ok_reTyped = (
  props: Omit<PanelProps, "variant"> & { variant?: "ghost" },
) => <Panel {...props} />;

// Same shape reached through a file-local alias.
type RetypedPanelProps = Omit<PanelProps, "variant"> & { variant?: "ghost" };
export const _ok_reTypedAlias = (props: RetypedPanelProps) => (
  <Panel {...props} />
);

// Allowed: a union of props shapes keeps only the keys every branch omits, and
// a value of the second branch may legitimately carry `orientation`.
export const _ok_unionBranchOmit = (
  props: Omit<PanelProps, "orientation"> | Omit<PanelProps, "variant">,
) => <Panel {...props} />;

// Allowed: a nested callback shadows `props`, so its spread is the callback's
// value, not the component's omitting one.
export const _ok_shadowedBinding = ({
  ...props
}: Omit<PanelProps, "orientation">) => (
  <Panel {...props} orientation="horizontal">
    {[<span key="a" />].map((props: PanelProps) => (
      <Panel {...props} />
    ))}
  </Panel>
);

// Allowed: the shadowing binding is a later parameter, not the first one.
export const _ok_shadowedSecondParam = ({
  ...props
}: Omit<PanelProps, "orientation">) => (
  <Panel {...props} orientation="horizontal">
    {[<span key="a" />].map((_item, props: PanelProps) => (
      <Panel {...props} />
    ))}
  </Panel>
);

// Allowed: the shadowing binding is a local, not a parameter at all.
export const _ok_shadowedLocal = ({
  ...props
}: Omit<PanelProps, "orientation">) => {
  const render = () => {
    const props: PanelProps = { id: "inner" };
    return <Panel {...props} />;
  };
  return (
    <Panel {...props} orientation="horizontal">
      {render()}
    </Panel>
  );
};

// Allowed: the trailing spread is a statically known object literal that does
// not declare the omitted key, so it cannot override the pin.
export const _ok_trailingLiteralSpread = (
  props: Omit<PanelProps, "orientation">,
) => <Panel {...props} orientation="horizontal" {...{ id: "panel" }} />;

// --- Flagged through shapes the parameter can take ---

// A defaulted props parameter parses as an assignment; the omission still binds.
export const _defaultedParam = (
  props: Omit<PanelProps, "orientation"> = {},
) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// Defaulted destructuring, same shape.
export const _defaultedDestructuring = ({
  ...props
}: Omit<PanelProps, "orientation"> = {}) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// A modifier utility changes property modifiers, not which keys exist, so the
// omission underneath it still holds.
export const _readonlyWrapper = (
  props: Readonly<Omit<PanelProps, "orientation">>,
) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// Allowed: the inner re-typing survives an outer omission of a different key,
// so only `orientation` is forbidden and it is pinned after the spread.
export const _ok_reTypedUnderNestedOmit = (
  props: Omit<
    Omit<PanelProps, "variant"> & { variant?: "ghost" },
    "orientation"
  >,
) => <Panel {...props} orientation="horizontal" />;

// A long alias chain still resolves: only a cycle stops the walk.
type Shell1 = Omit<PanelProps, "orientation">;
type Shell2 = Shell1;
type Shell3 = Shell2;
type Shell4 = Shell3;
type Shell5 = Shell4;
export const _deepAliasChain = (props: Shell5) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} />
);

// A JSX comment emits no child, so it does not pin an omitted `children`.
export const _commentOnlyChildren = (props: Omit<PanelProps, "children">) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props}>{/* nothing rendered here */}</Panel>
);

// A trailing object-literal spread that does declare the key still overrides
// the pin.
export const _trailingLiteralCarriesKey = (
  props: Omit<PanelProps, "orientation">,
) => (
  // oxlint-disable-next-line no-omitted-prop-respread/no-omitted-prop-respread
  <Panel {...props} orientation="horizontal" {...{ orientation: VERTICAL }} />
);
