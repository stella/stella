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

const legacyClassNames = (...values: unknown[]) => values.filter(Boolean).join(" ");

const MatterRow = ({ active, className, status }: MatterRowProps) => {
  const conditionalClasses = active ? "bg-muted" : "bg-background";
  const indirectClasses = conditionalClasses satisfies string;
  const canonicalClasses = cn("rounded-md", active && "ring-1");
  const canonicalAliasClasses = mergeClasses(
    "text-foreground",
    status === "closed" && "opacity-60",
  );
  const styleMap = { open: "font-medium", closed: "text-foreground-muted" };

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

      {/* Callback branch composition — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition */}
      <FixtureSlot className={({ selected }) => {
        if (selected) {
          return "bg-muted";
        }
        return "bg-background";
      }} />

      {/* Switch-branch composition — MUST flag. */}
      {/* oxlint-disable-next-line require-cn-for-classname-composition/require-cn-for-classname-composition, typescript/consistent-return -- fixture: every union member is covered by the switch */}
      <StatusSlot className={({ status: slotStatus }) => {
        switch (slotStatus) {
          case "open":
            return "font-medium";
          case "closed":
            return "opacity-60";
        }
      }} />

      {/* Static and pass-through values — MUST NOT flag. */}
      <div className="rounded-md" />
      <div className={`rounded-md`} />
      <div className={className} />
      <div className={styleMap[status]} />

      {/* Canonical direct, aliased, and const-indirected calls — MUST NOT flag. */}
      <div className={cn("rounded-md", active && "ring-1")} />
      <div className={mergeClasses("rounded-md", className)} />
      <div className={canonicalClasses} />
      <div className={canonicalAliasClasses satisfies string} />

      {/* Conditional callbacks remain valid when every branch uses cn(). */}
      <FixtureSlot className={({ selected }) => {
        if (selected) {
          return cn("rounded-md", className);
        }
        return mergeClasses("rounded-md", "opacity-60");
      }} />

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
