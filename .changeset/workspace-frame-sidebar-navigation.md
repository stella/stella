---
"@stll/workspace-ui": minor
"@stll/ui": minor
---

`WorkspaceFrame`'s described composition can now render its navigation through the sidebar shell from `@stll/ui/sidebar`. Pass `navigation.sidebar` to get the same collapsible sidebar Stella's own app uses: a header row at toolbar height with a brand slot and a collapse toggle, the described items as sidebar menu buttons with labels while expanded and tooltips while collapsed, and the footer slot below. `open`, `onOpenChange`, `defaultOpen`, and `forceCollapsed` pass through to the sidebar provider so the host owns persistence. Without `navigation.sidebar`, the frame renders the application rail exactly as before.

`WorkspaceViewSwitcher`'s strip is now one toolbar row (`TOOLBAR_ROW_HEIGHT`), the same height as the frame's top bar and a kanban column header, instead of taking its height from the tabs inside it.

`SidebarMenuButton` gains `size="rail"`: a 44px target while expanded and while collapsed to the icon rail, for a sidebar that stands in for the application rail.

`@stll/ui/sidebar` types the custom properties it sets on a local style type instead of a package-private module augmentation, so a consumer compiling the module from source no longer fails on `--sidebar-width`.
