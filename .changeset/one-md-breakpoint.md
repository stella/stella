---
"@stll/ui": minor
---

Remove `InspectorTabs`, `InspectorTabList`, `InspectorTab` and `InspectorTabPanel`. The tabbed inspector had no consumer; the docked inspector (`Inspector`, `InspectorDock`, `InspectorRail`) is the shape in use. A general tab strip is still `Tabs` from `@stll/ui/tabs`.

Give the `md` layout switch a single definition. `useIsMobile` read `768` px from `window.innerWidth` while the removed tabs read `(min-width: 48rem)` through `matchMedia`, so the two could disagree. The hook now uses the rem query that the `md:` utilities themselves compile to, read through `matchMedia`, which does not count a classic scrollbar the way `innerWidth` does. At a 16px root font size the behaviour is unchanged.
