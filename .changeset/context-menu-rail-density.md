---
"@stll/ui": minor
---

- `@stll/ui/context-menu`: the right-click `ContextMenu` (actions with icons, submenus, separators, a `checked` mark, and `closeOnClick` for toggles) moves from the app into the kit.
- `SidebarMenuButton` `size="rail"` centres its icon while the sidebar is collapsed: the label leaves the flow instead of only fading out.
- `KanbanSubgroupBoard` spends one row on an open lane's chrome instead of two: the per-column count row now renders only while a lane is collapsed (an open lane shows its cells, and a folded band's slot carries its own count), and the header and lane paddings tighten.
