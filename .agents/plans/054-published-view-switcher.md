# Published workspace view switcher

## Problem

The workspace app has a polished saved-view strip, but selection, overflow, and
drag reordering live inside one route beside persistence and menu mutations.
Other Stella workspace surfaces cannot reuse that interaction without copying
the route implementation.

## Users and outcome

Any Stella host that presents several saved layouts should be able to render one
consistent, accessible view switcher while retaining ownership of its data,
permissions, translations, mutations, and view-specific actions.

## Decision

Publish a controlled, entity-agnostic `WorkspaceViewSwitcher` from
`@stll/workspace-ui/view-switcher`. It accepts view identity and presentation
callbacks, emits selection and reordered IDs, and owns only the shared tabs and
drag-and-drop behavior. Migrate Stella's workspace route to consume it.

Publishing only the reorder functions would leave visual and accessibility
behavior duplicated. Moving the route component wholesale would couple the
package to queries, mutations, templates, and permissions.

## Scope

- Controlled selection with keyboard-compatible tabs
- Horizontal overflow and active-view actions
- Optional add control and inline-edit label
- Context-menu and double-click callbacks
- Bidi-aware drag reordering with host-provided announcement metadata
- Package exports, tests, documentation, and Stella app adoption

## Non-goals

- View CRUD, persistence, templates, permission rules, or toasts
- Rendering table, kanban, calendar, timeline, or other layouts
- Restricting hosts to a particular view-layout union

## Success criteria

- Stella's app imports the published switcher and contains no local tab drag
  implementation.
- Keyboard selection calls the controlled change callback.
- Reordering is deterministic, no-op aware, and mirrors correctly in RTL.
- The packed package exports the component and its public types.

## Risks and controls

- Drag registries can split across dependency versions: require Pragmatic DnD
  v3 and use its public v3 entry points.
- Scroll containers can clip insertion markers: paint markers inside tab bounds
  and let the shared tab list own overflow.
- Host accessibility announcements can be lost: merge host drag/drop data into
  the package's internal identity payload.
