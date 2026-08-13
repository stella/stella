// Passive regression fixture for
// `require-cn-for-classname-composition/require-cn-for-classname-composition`.
// Disabled attributes are production-shaped compositions the rule must flag;
// the unsuppressed attributes pin the safe boundary against false positives.

import { cn, cn as mergeClasses } from "@stll/ui/lib/utils";

type MatterRowProps = {
  active: boolean;
  className?: string;
  status: "open" | "closed";
};

const legacyClassNames = (...values: unknown[]) =>
  values.filter(Boolean).join(" ");

function declaredDynamicClass({ selected }: { selected: boolean }) {
  if (selected) {
    return "bg-muted";
  }
  return "bg-background";
}

function declaredCanonicalClass({ selected }: { selected: boolean }) {
  return cn("rounded-md", selected && "ring-1");
}

const MatterRow = ({ active, className, status }: MatterRowProps) => {
  const conditionalClasses = active ? "bg-muted" : "bg-background";
  const indirectClasses = conditionalClasses satisfies string;
  const canonicalClasses = cn("rounded-md", active && "ring-1");
  const canonicalAliasClasses = mergeClasses(
    "text-foreground",
    status === "closed" && "opacity-60",
  );
  const styleMap = { open: "font-medium", closed: "text-foreground-muted" };
  const localStyles = {
    root: active ? "bg-muted" : "bg-background",
    static: "rounded-md",
  };
  const aliasedStyles = localStyles;
  const spreadStyles = { ...aliasedStyles };
  const staticRowClass = "rounded-md";
  const staticRowClassAlias = staticRowClass;
  const callbackStyles = {
    selected: "rounded-md",
    unselected: `rounded-md`,
    active: "bg-muted",
    inactive: "bg-background",
  };
  const callbackCanonicalStyles = {
    selected: cn("rounded-md", "ring-1"),
    unselected: mergeClasses("rounded-md", "opacity-60"),
  };
  const tupleClasses = [
    active ? "bg-muted" : "bg-background",
    "rounded-md",
  ] as const;
  const destructuredStyles = {
    root: active ? "bg-muted" : "bg-background",
    merged: cn("rounded-md", active && "ring-1"),
  };
  const {
    root: destructuredDynamicClass,
    merged: destructuredCanonicalClass,
  } = destructuredStyles;
  // oxlint-disable-next-line prefer-const -- fixture: mutable declarations must not launder a dynamic initializer
  let mutableInitializerClass = active ? "bg-muted" : "bg-background";
  // oxlint-disable-next-line no-var -- fixture: var bindings must not launder dynamic class composition
  var mutableWrittenClass = "bg-background";
  if (active) {
    mutableWrittenClass = "bg-muted";
  }
  let equivalentMutableClass = "rounded-md";
  if (active) {
    equivalentMutableClass = `rounded-md`;
  }
  let canonicalMutableClass = cn("rounded-md", className);
  if (active) {
    canonicalMutableClass = mergeClasses("rounded-md", "ring-1");
  }
  const dynamicSpreadProps = {
    className: active ? "bg-muted" : "bg-background",
  };
  const canonicalSpreadProps = {
    className: cn("rounded-md", active && "ring-1"),
  };
  const restSourceProps = {
    className: active ? "bg-muted" : "bg-background",
    id: "matter-row",
  };
  const { id: _restId, ...dynamicRestProps } = restSourceProps;
  const { className: _removedClassName, ...safeRestProps } = restSourceProps;
  const memberMutationStyles = { root: "rounded-md" };
  if (active) {
    memberMutationStyles.root = "bg-muted";
  }
  const overwrittenMemberStyles = {
    root: active ? "bg-muted" : "bg-background",
  };
  overwrittenMemberStyles.root = "rounded-md";
  const canonicalMemberMutationStyles = {
    root: cn("rounded-md", className),
  };
  if (active) {
    canonicalMemberMutationStyles.root = mergeClasses(
      "rounded-md",
      "ring-1",
    );
  }
  type CyclicStyles = { className: string; self?: CyclicStyles };
  const cyclicStyles: CyclicStyles = { className: "rounded-md" };
  cyclicStyles.self = cyclicStyles;
  const extractedRowClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return "bg-muted";
    }
    return "bg-background";
  };
  const extractedDynamicClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return className;
    }
    return conditionalClasses;
  };
  // oxlint-disable-next-line typescript/consistent-return -- fixture: every union member is covered by the switch
  const extractedStatusClass = ({
    status: slotStatus,
  }: {
    status: "open" | "closed";
  }) => {
    switch (slotStatus) {
      case "open":
        return "font-medium";
      case "closed":
        return "opacity-60";
    }
  };
  const canonicalRowClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return cn("rounded-md", className);
    }
    return mergeClasses("rounded-md", "opacity-60");
  };
  const guardedStaticClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return "rounded-md";
    }
    return "rounded-md";
  };
  const conditionallyAssignedClass = ({ selected }: { selected: boolean }) => {
    let result = "bg-background";
    if (selected) {
      result = "bg-muted";
    }
    return result;
  };
  const ternaryAssignedClass = ({ selected }: { selected: boolean }) => {
    // oxlint-disable-next-line prefer-const -- fixture: a separate top-level assignment is the laundering shape under test
    let result: string;
    result = selected ? "bg-muted" : "bg-background";
    return result;
  };
  const equivalentLiteralClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return "rounded-md";
    }
    return `rounded-md`;
  };
  const equivalentAliasClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return staticRowClassAlias;
    }
    return "rounded-md";
  };
  const equivalentMemberClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return callbackStyles.selected;
    }
    return callbackStyles.unselected;
  };
  const differingMemberClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return callbackStyles.active;
    }
    return callbackStyles.inactive;
  };
  const canonicalMemberClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return callbackCanonicalStyles.selected;
    }
    return callbackCanonicalStyles.unselected;
  };
  const unrelatedControlFlowClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      legacyClassNames("selected");
    }
    return "rounded-md";
  };

  return (
    <div>
      {/* Conditional expression — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={active ? "bg-muted" : "bg-background"} />

      {/* Logical expression — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={active && "ring-1"} />

      {/* Dynamic template — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={`rounded-md ${className}`} />

      {/* String concatenation — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition, prefer-template -- fixture: concatenation is one of the rejected composition shapes */}
      <div className={"rounded-md " + className} />

      {/* A non-canonical composition helper — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={legacyClassNames("rounded-md", active && "ring-1")} />

      {/* Const indirection through a TypeScript wrapper — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition, typescript/no-unnecessary-type-assertion -- fixture: the rule must follow TypeScript expression wrappers */}
      <div className={indirectClasses as string} />

      {/* Locally owned member indirection — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={localStyles.root} />

      {/* Const-alias and object-spread laundering — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={spreadStyles.root} />

      {/* Mutable local values and writes — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={mutableInitializerClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={mutableWrittenClass} />

      {/* Destructured and numeric-member laundering — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={destructuredDynamicClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={tupleClasses[0]} />

      {/* Locally owned spread className composition — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div {...dynamicSpreadProps} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div data-rest-id={_restId} {...dynamicRestProps} />

      {/* Conditional local member writes — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={memberMutationStyles.root} />

      {/* Extracted block and switch callback composition — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={extractedRowClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={extractedDynamicClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <StatusSlot className={extractedStatusClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={declaredDynamicClass} />

      {/* Static and pass-through values — MUST NOT flag. */}
      <div className="rounded-md" />
      <div className={`rounded-md`} />
      <div className={className} />
      <div className={styleMap[status]} />
      <div className={localStyles.static} />
      <div className={tupleClasses[1]} />
      <div className={equivalentMutableClass} />
      <div className={overwrittenMemberStyles.root} />
      {/* Cyclic local object graphs terminate without inventing provenance. */}
      {/* oxlint-disable-next-line typescript/no-unnecessary-condition -- fixture: retain a cyclic optional-member resolver path */}
      <div className={cyclicStyles.self?.self?.className} />
      <div data-removed-class={_removedClassName} {...safeRestProps} />

      {/* Canonical direct, aliased, and const-indirected calls — MUST NOT flag. */}
      <div className={cn("rounded-md", active && "ring-1")} />
      <div className={mergeClasses("rounded-md", className)} />
      <div className={canonicalClasses} />
      <div className={canonicalAliasClasses satisfies string} />
      <div className={destructuredCanonicalClass} />
      <div className={canonicalMutableClass} />
      <div {...canonicalSpreadProps} />
      <div className={canonicalMemberMutationStyles.root} />

      {/* Conditional callbacks remain valid when every branch uses cn(). */}
      <FixtureSlot className={canonicalRowClass} />
      <FixtureSlot className={canonicalMemberClass} />
      <FixtureSlot className={declaredCanonicalClass} />

      {/* A conditionally assigned returned value is composition: MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={conditionallyAssignedClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={ternaryAssignedClass} />

      {/* Distinct locally owned member returns are composition: MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={differingMemberClass} />

      {/* Equivalent static returns are not composition. */}
      <FixtureSlot className={guardedStaticClass} />
      <FixtureSlot className={equivalentLiteralClass} />
      <FixtureSlot className={equivalentAliasClass} />
      <FixtureSlot className={equivalentMemberClass} />

      {/* Unrelated control flow with one static return is not composition. */}
      <FixtureSlot className={unrelatedControlFlowClass} />

      <ShadowedCn active={active} />
      <ExternalSpread className={className} />
      <ExternalTuple classes={[className]} />
      <ExternalMember styles={localStyles} />
      <OpaqueSpreadBoundary active={active} className={className} />
      <ReassignedDeclarationBoundary className={canonicalRowClass} />
    </div>
  );
};

const ShadowedCn = ({ active }: { active: boolean }) => {
  // oxlint-disable-next-line no-shadow -- fixture: a local namesake must not satisfy the canonical-import check
  const cn = (...values: unknown[]) => values.filter(Boolean).join(" ");

  return (
    <div>
      {/* A local binding named cn is not the canonical import — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={cn("rounded-md", active && "ring-1")} />
    </div>
  );
};

const FixtureSlot = ({
  className: _className,
}: {
  className: (state: { selected: boolean }) => string;
}) => null;

const StatusSlot = ({
  className: _className,
}: {
  className: (state: { status: "open" | "closed" }) => string;
}) => null;

const ExternalSpread = (props: { className?: string }) => <div {...props} />;

const ExternalTuple = ({ classes }: { classes: (string | undefined)[] }) => (
  <div className={classes[0]} />
);

const ExternalMember = ({
  styles,
}: {
  styles: { root: string };
}) => <div className={styles.root} />;

const OpaqueSpreadBoundary = ({
  active,
  ...externalProps
}: {
  active: boolean;
  className?: string;
}) => {
  const opaqueRightmostSpread = {
    className: active ? "bg-muted" : "bg-background",
    ...externalProps,
  };
  const dynamicRightmostProperty = {
    ...externalProps,
    className: active ? "bg-muted" : "bg-background",
  };
  return (
    <div {...opaqueRightmostSpread}>
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div {...dynamicRightmostProperty} />
    </div>
  );
};

const ReassignedDeclarationBoundary = ({
  className,
}: {
  className: (state: { selected: boolean }) => string;
}) => {
  function localClassName({ selected }: { selected: boolean }) {
    return selected ? "bg-muted" : "bg-background";
  }
  // oxlint-disable-next-line no-func-assign -- fixture: writable declarations must stop resolving to their original body
  localClassName = className;
  return <FixtureSlot className={localClassName} />;
};

export const __requireCnForClassnameCompositionFixture = MatterRow;
