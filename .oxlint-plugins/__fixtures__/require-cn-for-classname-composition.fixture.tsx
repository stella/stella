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

      {/* Extracted block and switch callback composition — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={extractedRowClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={extractedDynamicClass} />
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <StatusSlot className={extractedStatusClass} />

      {/* Static and pass-through values — MUST NOT flag. */}
      <div className="rounded-md" />
      <div className={`rounded-md`} />
      <div className={className} />
      <div className={styleMap[status]} />
      <div className={localStyles.static} />

      {/* Canonical direct, aliased, and const-indirected calls — MUST NOT flag. */}
      <div className={cn("rounded-md", active && "ring-1")} />
      <div className={mergeClasses("rounded-md", className)} />
      <div className={canonicalClasses} />
      <div className={canonicalAliasClasses satisfies string} />

      {/* Conditional callbacks remain valid when every branch uses cn(). */}
      <FixtureSlot className={canonicalRowClass} />

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

export const __requireCnForClassnameCompositionFixture = MatterRow;
