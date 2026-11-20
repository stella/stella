import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { PlusIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { TruncatedTextFace } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/*
 * The category sidebar's shape (./category-sidebar.tsx): its column, the
 * nav, the create row under it and the mobile filter row, with no
 * behaviour, so a section's loading view draws the sidebar it stands in for
 * before any provider mounts.
 */

/** The sidebar's column; the live sidebar makes it scroll. */
export const CategorySidebarFrame = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) => (
  <div
    className={cn("flex w-48 shrink-0 flex-col", className)}
    data-slot="category-sidebar"
  >
    {children}
  </div>
);

/** The sidebar's list of filters: all, uncategorized, then the categories. */
export const CategorySidebarNav = ({ children }: { children: ReactNode }) => (
  <nav className="flex-1 p-2">{children}</nav>
);

/** The divider between the fixed filters and the categories. */
export const CategorySidebarDivider = () => <div className="my-1 border-t" />;

/** The create-category row under the nav. */
export const CategorySidebarFooter = ({
  children,
}: {
  children: ReactNode;
}) => <div className="border-t p-2">{children}</div>;

/** The mobile row of filter buttons, in place of the sidebar; the live
 *  row scrolls sideways. */
export const CategoryMobileFilterBarFrame = ({
  children,
  rowClassName,
}: {
  children: ReactNode;
  rowClassName?: string | undefined;
}) => (
  <div className="border-b px-3 py-2 md:hidden">
    <div className={cn("flex gap-1 pb-0.5", rowClassName)}>{children}</div>
  </div>
);

/** Which fixed filter the section opens on, if any. */
type CategoryPendingSelection = "all" | "uncategorized" | "category";

type CategorySidebarPendingProps = {
  /** The "all" filter's label, as the section names it. */
  allLabel: ReactNode;
  /** The member's role may create categories. */
  canCreate: boolean;
  selection: CategoryPendingSelection;
};

const NavRowFace = ({
  label,
  selected,
}: {
  label: ReactNode;
  selected: boolean;
}) => (
  <div className={cn("rounded-md", selected && "bg-muted")}>
    <ButtonFace size="row" variant="ghost">
      <span className={cn("min-w-0", selected ? "font-medium" : "font-normal")}>
        <TruncatedTextFace>{label}</TruncatedTextFace>
      </span>
    </ButtonFace>
  </div>
);

const CATEGORY_KEYS = ["a", "b", "c"];
const CATEGORY_WIDTHS = ["w-24", "w-20", "w-28"];

const CreateCategoryLabel = () => (
  <PendingText barClassName="w-24" id="common.createCategory" />
);

/** The sidebar while the categories load: the fixed filters and the create
 *  row are there; each category is a bar on its row. */
export const CategorySidebarPending = ({
  allLabel,
  canCreate,
  selection,
}: CategorySidebarPendingProps) => (
  <CategorySidebarFrame>
    <CategorySidebarNav>
      <NavRowFace label={allLabel} selected={selection === "all"} />
      <NavRowFace
        label={<PendingText barClassName="w-20" id="common.uncategorized" />}
        selected={selection === "uncategorized"}
      />
      <CategorySidebarDivider />
      {CATEGORY_KEYS.map((key, index) => (
        <NavRowFace
          key={key}
          label={
            <InlineSkeleton className={cn("h-3", CATEGORY_WIDTHS[index])} />
          }
          selected={false}
        />
      ))}
    </CategorySidebarNav>
    {canCreate && (
      <CategorySidebarFooter>
        <ButtonFace className="w-full justify-start" size="sm" variant="ghost">
          <PlusIcon />
          <CreateCategoryLabel />
        </ButtonFace>
      </CategorySidebarFooter>
    )}
  </CategorySidebarFrame>
);

/** The mobile filter row while the categories load. */
export const CategoryMobileFilterBarPending = ({
  allLabel,
  canCreate,
  selection,
}: CategorySidebarPendingProps) => (
  <CategoryMobileFilterBarFrame>
    <ButtonFace
      className="shrink-0"
      size="default"
      variant={selection === "all" ? "default" : "outline"}
    >
      <TruncatedTextFace className="max-w-40">{allLabel}</TruncatedTextFace>
    </ButtonFace>
    <ButtonFace
      className="shrink-0"
      size="default"
      variant={selection === "uncategorized" ? "default" : "outline"}
    >
      <TruncatedTextFace className="max-w-40">
        <PendingText barClassName="w-20" id="common.uncategorized" />
      </TruncatedTextFace>
    </ButtonFace>
    {canCreate && (
      <ButtonFace className="h-8 shrink-0" size="sm" variant="ghost">
        <PlusIcon />
        <CreateCategoryLabel />
      </ButtonFace>
    )}
  </CategoryMobileFilterBarFrame>
);
