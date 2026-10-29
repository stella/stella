import { MenuAnchor, MenuTrigger } from "@stll/ui/menu";
import { ownsContextMenuTarget as ownsTarget } from "@/components/context-menu-target";

const t = (key: string) => key;
const labels = { add: "Add", addSort: "Sort" };
const Button = (_props: Record<string, unknown>) => null;
const SortChips = (_props: Record<string, unknown>) => null;

export const Fixture = () => (
  <>
    {/* expect-clean: semantic-controls/require-context-menu-target */}
    <div data-context-menu-target="matter" onContextMenu={(event) => {
      if (!ownsTarget(event)) {return;}
      event.preventDefault();
    }} />
    {/* oxlint-disable-next-line semantic-controls/require-context-menu-target -- fixture: marked parents must resolve the nearest row before opening actions */}
    <div data-context-menu-target="matter" onContextMenu={(event) => event.preventDefault()} />
    {/* expect-clean: semantic-controls/require-menu-anchor */}
    <MenuAnchor />
    {/* oxlint-disable-next-line semantic-controls/require-menu-anchor -- fixture: hidden raw triggers must use the nonfocusable owner */}
    <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />
    {/* expect-clean: semantic-controls/require-specific-icon-label */}
    <Button aria-label={labels.addSort} size="icon-xs" />
    {/* oxlint-disable-next-line semantic-controls/require-specific-icon-label -- fixture: an icon cannot describe its action as generic add */}
    <Button aria-label={labels.add} size="icon-xs" />
    {/* oxlint-disable-next-line semantic-controls/require-specific-icon-label -- fixture: caller translations must preserve the sort intent */}
    <SortChips labels={{ addSort: t("common.add") }} />
  </>
);
