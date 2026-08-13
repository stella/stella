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
  const { root: destructuredDynamicClass, merged: destructuredCanonicalClass } =
    destructuredStyles;
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
  const conditionalSpreadProps = active
    ? { className: "bg-muted" }
    : { className: "bg-background" };
  const canonicalSpreadProps = {
    className: cn("rounded-md", active && "ring-1"),
  };
  const conditionalCanonicalSpreadProps = active
    ? { className: cn("rounded-md", "ring-1") }
    : { className: mergeClasses("rounded-md", "opacity-60") };
  const logicalSpreadProps = active && {
    className: status === "closed" ? "bg-muted" : "bg-background",
  };
  const canonicalLogicalSpreadProps = active && {
    className: cn("rounded-md", status === "closed" && "ring-1"),
  };
  const partialOverrideSpreadProps = {
    className: active ? "bg-muted" : "bg-background",
    ...(status === "closed" && {
      className: cn("rounded-md", "opacity-60"),
    }),
  };
  const canonicalPartialOverrideSpreadProps = {
    className: cn("rounded-md", active && "ring-1"),
    ...(status === "closed" && {
      className: mergeClasses("rounded-md", "opacity-60"),
    }),
  };
  const suffixedSpreadProps = {
    contentClassName: active ? "bg-muted" : "bg-background",
  };
  const canonicalSuffixedSpreadProps = {
    contentClassName: cn("rounded-md", active && "ring-1"),
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
  const aliasMutationStyles = { root: "rounded-md" };
  const mutationAlias = aliasMutationStyles;
  if (active) {
    mutationAlias.root = "bg-muted";
  }
  const overwrittenMemberStyles = {
    root: active ? "bg-muted" : "bg-background",
  };
  overwrittenMemberStyles.root = "rounded-md";
  const canonicalMemberMutationStyles = {
    root: cn("rounded-md", className),
  };
  if (active) {
    canonicalMemberMutationStyles.root = mergeClasses("rounded-md", "ring-1");
  }
  const canonicalAliasMutationStyles = {
    root: cn("rounded-md", className),
  };
  const canonicalMutationAlias = canonicalAliasMutationStyles;
  if (active) {
    canonicalMutationAlias.root = mergeClasses("rounded-md", "ring-1");
  }
  const nestedAliasMutationStyles = { root: "rounded-md" };
  if (active) {
    const nestedMutationAlias = nestedAliasMutationStyles;
    nestedMutationAlias.root = "bg-muted";
  }
  const canonicalNestedAliasMutationStyles = {
    root: cn("rounded-md", className),
  };
  if (active) {
    const canonicalNestedMutationAlias = canonicalNestedAliasMutationStyles;
    canonicalNestedMutationAlias.root = mergeClasses("rounded-md", "ring-1");
  }
  const conditionalMemberPresenceStyles: { root?: string } = {};
  const canonicalConditionalMemberPresenceStyles: { root?: string } = {};
  if (active) {
    conditionalMemberPresenceStyles.root = "rounded-md";
    canonicalConditionalMemberPresenceStyles.root = cn("rounded-md", "ring-1");
  }
  const postSnapshotStyles = { root: "rounded-md" };
  const { root: destructuredSnapshotClass } = postSnapshotStyles;
  const spreadSnapshotStyles = { ...postSnapshotStyles };
  if (active) {
    postSnapshotStyles.root = "bg-muted";
  }
  const preSnapshotStyles = { root: "rounded-md" };
  if (active) {
    preSnapshotStyles.root = "bg-muted";
  }
  const { root: dynamicDestructuredSnapshotClass } = preSnapshotStyles;
  const dynamicSpreadSnapshotStyles = { ...preSnapshotStyles };
  const { className: explicitUndefinedDefaultClass = conditionalClasses } = {
    className: undefined,
  };
  const mixedDefaultSource = active ? {} : { className: "rounded-md" };
  const { className: mixedDefaultClass = conditionalClasses } =
    mixedDefaultSource;
  const { className: canonicalUndefinedDefaultClass = canonicalClasses } = {
    className: undefined,
  };
  let catchWrittenClass = "rounded-md";
  let equivalentCatchWrittenClass = "rounded-md";
  try {
    legacyClassNames("catch-probe");
  } catch {
    catchWrittenClass = "bg-muted";
    equivalentCatchWrittenClass = `rounded-md`;
  }
  const catchMutationStyles = { root: "rounded-md" };
  const catchMutationAlias = catchMutationStyles;
  const canonicalCatchMutationStyles = {
    root: cn("rounded-md", className),
  };
  const canonicalCatchMutationAlias = canonicalCatchMutationStyles;
  try {
    legacyClassNames("member-catch-probe");
  } catch {
    catchMutationAlias.root = "bg-muted";
    canonicalCatchMutationAlias.root = mergeClasses("rounded-md", "ring-1");
  }
  const computedRootKey = "root";
  const computedTemplateKey = `root`;
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
  // oxlint-disable-next-line typescript/consistent-return -- fixture: reachable fallthrough is the rejected callback outcome under test
  const fallthroughClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return "bg-muted";
    }
  };
  // oxlint-disable-next-line typescript/consistent-return -- fixture: canonical returns may have an absent callback outcome
  const canonicalFallthroughClass = ({ selected }: { selected: boolean }) => {
    if (selected) {
      return cn("rounded-md", "ring-1");
    }
  };
  const catchAssignedClass = () => {
    let result = "rounded-md";
    try {
      legacyClassNames("callback-catch-probe");
    } catch {
      result = "bg-muted";
    }
    return result;
  };
  const canonicalCatchAssignedClass = () => {
    let result = cn("rounded-md", className);
    try {
      legacyClassNames("canonical-callback-catch-probe");
    } catch {
      result = mergeClasses("rounded-md", "ring-1");
    }
    return result;
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
      <div {...conditionalSpreadProps} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div {...logicalSpreadProps} />
      {/* A partial rightmost spread must retain the earlier fallback. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div {...partialOverrideSpreadProps} />
      {/* Suffixed class-name props in local spreads — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <ClassNameSurface {...suffixedSpreadProps} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div data-rest-id={_restId} {...dynamicRestProps} />

      {/* Conditional local member writes — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={memberMutationStyles.root} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={aliasMutationStyles.root} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={nestedAliasMutationStyles.root} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={conditionalMemberPresenceStyles.root} />
      {/* Catch-only local and alias writes remain conditional — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={catchWrittenClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={catchMutationStyles.root} />

      {/* Stable computed property keys retain local provenance — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={localStyles[computedRootKey]} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={localStyles[computedTemplateKey]} />

      {/* Eager snapshots include mutations before, but not after, capture. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={dynamicDestructuredSnapshotClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={dynamicSpreadSnapshotStyles.root} />

      {/* Defaults apply to explicit and possible undefined values — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={explicitUndefinedDefaultClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={mixedDefaultClass} />

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
      <div className={equivalentCatchWrittenClass} />
      <div className={overwrittenMemberStyles.root} />
      <div className={destructuredSnapshotClass} />
      <div className={spreadSnapshotStyles.root} />
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
      <div className={canonicalAliasMutationStyles.root} />
      <div className={canonicalNestedAliasMutationStyles.root} />
      <div className={canonicalConditionalMemberPresenceStyles.root} />
      <div {...conditionalCanonicalSpreadProps} />
      <div {...canonicalLogicalSpreadProps} />
      <div {...canonicalPartialOverrideSpreadProps} />
      <ClassNameSurface {...canonicalSuffixedSpreadProps} />
      <div className={canonicalUndefinedDefaultClass} />
      <div className={canonicalCatchMutationStyles.root} />

      {/* Conditional callbacks remain valid when every branch uses cn(). */}
      <FixtureSlot className={canonicalRowClass} />
      <FixtureSlot className={canonicalMemberClass} />
      <FixtureSlot className={declaredCanonicalClass} />
      <OptionalFixtureSlot className={canonicalFallthroughClass} />
      <FixtureSlot className={canonicalCatchAssignedClass} />

      {/* A conditionally assigned returned value is composition: MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={conditionallyAssignedClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={ternaryAssignedClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <OptionalFixtureSlot className={fallthroughClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={catchAssignedClass} />

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
      <DestructuringDefaultBoundary className={className} />
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

const OptionalFixtureSlot = ({
  className: _className,
}: {
  className: (state: { selected: boolean }) => string | undefined;
}) => null;

const ClassNameSurface = ({
  contentClassName: _contentClassName,
}: {
  contentClassName: string;
}) => null;

const ExternalSpread = (props: { className?: string }) => <div {...props} />;

const ExternalTuple = ({ classes }: { classes: (string | undefined)[] }) => (
  <div className={classes[0]} />
);

const ExternalMember = ({ styles }: { styles: { root: string } }) => (
  <div className={styles.root} />
);

const OpaqueSpreadBoundary = ({
  active,
  opaqueProps,
  ...externalProps
}: {
  active: boolean;
  className?: string;
  opaqueProps?: { className?: string };
}) => {
  const opaqueRightmostSpread = {
    className: active ? "bg-muted" : "bg-background",
    ...externalProps,
  };
  const dynamicRightmostProperty = {
    ...externalProps,
    className: active ? "bg-muted" : "bg-background",
  };
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- fixture: logical-or object provenance must remain opaque when the left branch is external
  const opaqueLogicalSpread = opaqueProps || {
    className: active ? "bg-muted" : "bg-background",
  };
  return (
    <div {...opaqueRightmostSpread}>
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div {...dynamicRightmostProperty} />
      <div {...opaqueLogicalSpread} />
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

const DestructuringDefaultBoundary = (props: { className?: string }) => {
  const { className = "rounded-md" } = props;
  const localDefaultSource: { className?: string; id: string } = {
    id: "local",
  };
  const { className: localDefault = "rounded-md" } = localDefaultSource;
  return (
    <div>
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <div className={className} />
      <div className={localDefault} />
    </div>
  );
};

export const __requireCnForClassnameCompositionFixture = MatterRow;
