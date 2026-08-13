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
    slotStatus,
  }: {
    slotStatus: "open" | "closed";
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

      {/* Control flow returning one static value is not composition. */}
      <FixtureSlot className={guardedStaticClass} />

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
