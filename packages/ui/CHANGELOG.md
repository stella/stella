# @stll/ui

## 0.34.6

### Patch Changes

- [#3893](https://github.com/stella/stella/pull/3893) [`9a272b8`](https://github.com/stella/stella/commit/9a272b879e97db76224c82ceff72705678001d77) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Component hover, focus and selection colours, borders and shadows change instantly; remaining component motion animates transform and opacity only.

## 0.34.5

### Patch Changes

- [#3855](https://github.com/stella/stella/pull/3855) [`87d7e83`](https://github.com/stella/stella/commit/87d7e83e147338c5450be4e3db0904873c862d16) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow values with type guards instead of type assertions, and give internal CLI helpers names that describe what they hold. `mapEntityStatus` now reads only the codes its mapping declares, so an inherited object key maps to `unknown`.

## 0.34.4

### Patch Changes

- [#3744](https://github.com/stella/stella/pull/3744) [`de044f5`](https://github.com/stella/stella/commit/de044f5f0c926a7b7b722fd588e24c845a48c64d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the inspector layout tokens as `@stll/ui/layout-tokens`, and export the shared field-value parts (`formatIntFieldValue`, `PersonAvatar`, `PendingSkeleton`, the empty, error, unsupported and clip renderers, and the select and int styling helpers) from `@stll/workspace-ui/field-value`.

- [#3733](https://github.com/stella/stella/pull/3733) [`baf3942`](https://github.com/stella/stella/commit/baf3942ca885c16b7b9542f3cc2fb8b1e8a15f84) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Invalid input now raises a tagged error (`ChatAnonInputLimitError` in anonymize-chat) or a `Panic` (resource calendar) instead of a native `RangeError` or `TypeError`.

- [#3754](https://github.com/stella/stella/pull/3754) [`6b7dcc2`](https://github.com/stella/stella/commit/6b7dcc2aa330b863c8638497f5e463aa776480f4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Template and capability commands advertise the input bounds and defaults the server already enforced. `DestructiveConfirmDialog` reports an unexpected confirm rejection instead of dropping it.

## 0.34.3

### Patch Changes

- [#3728](https://github.com/stella/stella/pull/3728) [`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow optional values before they reach rendered text and messages. The outline rail no longer draws a tick for a heading whose id matches an object prototype key.

## 0.34.2

### Patch Changes

- [#3689](https://github.com/stella/stella/pull/3689) [`d25a637`](https://github.com/stella/stella/commit/d25a6371bde1ab91a28550a84a25fd5188e8a677) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep workspace inspector rails flush with the viewport when overlays lock document scrolling.

## 0.34.1

### Patch Changes

- [#3629](https://github.com/stella/stella/pull/3629) [`fb26894`](https://github.com/stella/stella/commit/fb26894adbb0596be16e30c17b293f41058fe518) Thanks [@dependabot](https://github.com/apps/dependabot)! - Raise the `@tanstack/react-virtual` peer dependency floor used by `@stll/ui`.

## 0.34.0

### Minor Changes

- [#3559](https://github.com/stella/stella/pull/3559) [`49b0423`](https://github.com/stella/stella/commit/49b04238ec5fd6e369b037edd732f56e0d12de62) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `openFilePicker` (`@stll/ui/file-picker`) opens the browser file chooser from any handler without an `<input type="file">` in the tree, so surfaces no longer carry a hidden input, a ref, or the value reset that lets the same file be picked twice. `FileInput` now uses it and renders no native input; `onFileChange` receives a `File` and is not called when the chooser is dismissed.

### Patch Changes

- [#3561](https://github.com/stella/stella/pull/3561) [`528c647`](https://github.com/stella/stella/commit/528c647d8822c7b701e6ecb4f5ed637cd83f48ff) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Restrict component transitions to compositable properties while preserving deliberate box-size motion.

- [#3593](https://github.com/stella/stella/pull/3593) [`2c53e9f`](https://github.com/stella/stella/commit/2c53e9fba0b5607f3d90c0c4456db5d0ee5a5d21) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose stable semantic metadata for selectable inspector, toolbar, and workspace-view controls.

## 0.33.1

### Patch Changes

- [#3539](https://github.com/stella/stella/pull/3539) [`c40f24f`](https://github.com/stella/stella/commit/c40f24f61f7a5f000ab1728b28af473c26950baa) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update `tailwind-merge` to `^3.7.0`.

## 0.33.0

### Minor Changes

- [#3584](https://github.com/stella/stella/pull/3584) [`7b059b3`](https://github.com/stella/stella/commit/7b059b3856829ee676a73125d766c8b9c15f71fb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `Button` and `CommandItem` gain a `row` size built from one shared metric, and `MenuSection` owns the inset, heading and row stack of a titled group of menu rows, so sibling lists in one panel share a density.

## 0.32.0

### Minor Changes

- [#3578](https://github.com/stella/stella/pull/3578) [`123956f`](https://github.com/stella/stella/commit/123956f16ae7504a8a523c2831a59d9b55ca750e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Tooltips render on the transient popup layer, so a tooltip opened from a dialog covers it. `TooltipPopup` no longer accepts `layer` and `Button` no longer accepts `tooltipLayer`.

## 0.31.0

### Minor Changes

- [#3551](https://github.com/stella/stella/pull/3551) [`708194f`](https://github.com/stella/stella/commit/708194f5132bb512d9aae6441d3cdb52bf984a08) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `FileInput` picks a single file behind a translated `Button` and shows the chosen name, replacing the browser's untranslatable "Choose file" chrome. `Input` no longer accepts `type="file"`.

## 0.30.0

### Minor Changes

- [#3546](https://github.com/stella/stella/pull/3546) [`b983020`](https://github.com/stella/stella/commit/b983020612e73f9039b869c629c9a2dd412f17cd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Select lists open upward when the trigger sits at the bottom of the viewport instead of landing off screen. `SelectPopup` no longer accepts `collisionAvoidance`; collision handling is Base UI's dropdown default for every select.

## 0.29.2

### Patch Changes

- [#3497](https://github.com/stella/stella/pull/3497) [`4ae60ab`](https://github.com/stella/stella/commit/4ae60ab4ca96d6c2e84f454e28e5e04511d9eb99) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Court badges: the apex weight is an edge, not a block of inverted ink

## 0.29.1

### Patch Changes

- [#3477](https://github.com/stella/stella/pull/3477) [`26ecb15`](https://github.com/stella/stella/commit/26ecb155f894000172424d27d2e30d38f88288c3) Thanks [@dependabot](https://github.com/apps/dependabot)! - Require `@tanstack/react-virtual` 3.14.12 or newer for the virtualized UI components.

## 0.29.0

### Minor Changes

- [#3453](https://github.com/stella/stella/pull/3453) [`15b8cb3`](https://github.com/stella/stella/commit/15b8cb3b3ea8acbf7a99dca23751709aed7c852e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `muted` and `destructive-ghost` Button variants and the `text-2xs` and `text-3xs` theme tokens. `buttonVariants` and `buttonAccessibleDisabledClass` now export from `@stll/ui/button`; the `@stll/ui/button-variants` entry is gone.

- [#3453](https://github.com/stella/stella/pull/3453) [`15b8cb3`](https://github.com/stella/stella/commit/15b8cb3b3ea8acbf7a99dca23751709aed7c852e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `PopoverPopup` takes a `padding` prop (`none`, `xs`, `sm`, `md`, `default`) for its viewport instead of callers reaching into the `popover-viewport` slot. `SelectTrigger size="sm"` and `Button size="sm"` render small text themselves. Theme tokens `shadow-floating` and `shadow-floating-ring` replace inline shadow recipes.

## 0.28.2

### Patch Changes

- [#3461](https://github.com/stella/stella/pull/3461) [`4cd7250`](https://github.com/stella/stella/commit/4cd725073dd7db4f0874040482bdd513cc92bcb2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `ScrollArea` takes an `axis` prop, so a surface whose inline size belongs to the reader can refuse the horizontal axis.

## 0.28.1

### Patch Changes

- [#3448](https://github.com/stella/stella/pull/3448) [`08d97f9`](https://github.com/stella/stella/commit/08d97f95cc33fb11dab29a05a1eeb235f3c8945a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Court badges: larger, higher-contrast abbreviations with room for diacritics

## 0.28.0

### Minor Changes

- [#3435](https://github.com/stella/stella/pull/3435) [`79b2d6f`](https://github.com/stella/stella/commit/79b2d6f8aa38df700555a2cdaa796af36c536433) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add agenda-kind filters and shared view-toolbar and Kanban proposal primitives. Expose cross-matter saved-view operations through the generated CLI capability tree. Replace view-switcher `renderActions` with `actionMenu`, which owns the vertical menu trigger. Hide redundant empty-lane counts and let empty Kanban cells scroll with the board.

## 0.27.3

### Patch Changes

- [#3396](https://github.com/stella/stella/pull/3396) [`3cee5ea`](https://github.com/stella/stella/commit/3cee5eab989c3966ed440749f7d5bfc6f1c66ee7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `chrome-raised` overlay layer, one step above `chrome`, for in-pane controls that float over the docked composer. The composer's veil blurs what lies beneath it, so a control in the same band stayed sharp only when it happened to mount after the composer.

## 0.27.2

### Patch Changes

- [#3352](https://github.com/stella/stella/pull/3352) [`b6b1677`](https://github.com/stella/stella/commit/b6b167764508d6a6956e014659a1a123769468a8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `CourtBadge`, a monospace chip for a court's abbreviation. It is weighted rather than coloured — solid ink, tinted, outlined, dashed — so the chip reads the same to a monochrome or colour-blind reader, and it is drawn beside the court's name rather than instead of it.

- [#3366](https://github.com/stella/stella/pull/3366) [`da29d32`](https://github.com/stella/stella/commit/da29d326346708632bfcf35afdae7c821e9e0655) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Let the control wrapper own an `Input`'s height. The element no longer states a height of its own at any size: it fills the control and keeps its line box as a `min-h-*` floor, so a height passed in `className` reaches the text and the caret instead of leaving them at the top of a taller box while the search icon centres on it.

## 0.27.1

### Patch Changes

- [#3354](https://github.com/stella/stella/pull/3354) [`19b1db8`](https://github.com/stella/stella/commit/19b1db8e9abf8697a94be987a5b5261c77d4dd7a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render `OutlineRail` rows in the regular foreground rather than a muted grey, and let an entry ask for `secondary` emphasis so a caller that ranks its entries can step the near-misses back. Keep a controlled active row scrolled into view while the panel is open, and forward a wheel the panel cannot consume to the document behind it, so an outline with nothing to scroll no longer swallows the gesture. Mirror the disclosure chevron under RTL while it is collapsed, and mark the active row with `aria-current`.

## 0.27.0

### Minor Changes

- [#3338](https://github.com/stella/stella/pull/3338) [`c39769f`](https://github.com/stella/stella/commit/c39769fb528e2b195b127bf64a7f9c42520747b8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove `InspectorTabs`, `InspectorTabList`, `InspectorTab` and `InspectorTabPanel`. The tabbed inspector had no consumer; the docked inspector (`Inspector`, `InspectorDock`, `InspectorRail`) is the shape in use. A general tab strip is still `Tabs` from `@stll/ui/tabs`.

  Give the `md` layout switch a single definition. `useIsMobile` read `768` px from `window.innerWidth` while the removed tabs read `(min-width: 48rem)` through `matchMedia`, so the two could disagree. The hook now uses the rem query that the `md:` utilities themselves compile to, read through `matchMedia`, which does not count a classic scrollbar the way `innerWidth` does. At a 16px root font size the behaviour is unchanged.

## 0.26.5

### Patch Changes

- [#3309](https://github.com/stella/stella/pull/3309) [`cd800f5`](https://github.com/stella/stella/commit/cd800f5d45775061e030356c7938519657a35c53) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Let `InspectorDock` say where it is mounted, so a dock that a page hangs inside the content column paints above the shell's sticky top bar instead of behind it. Clamp a dragged pane width to the pane's own bounds before it is kept, so a drag past either bound is remembered as that bound rather than reset to the default on the next load.

## 0.26.4

### Patch Changes

- [#3289](https://github.com/stella/stella/pull/3289) [`7da4d12`](https://github.com/stella/stella/commit/7da4d12d1e4b5b518fb9d28ee12c28fb5b47eecc) Thanks [@dependabot](https://github.com/apps/dependabot)! - Require `@tanstack/react-virtual` 3.14.11 or newer for the virtualized UI components.

## 0.26.3

### Patch Changes

- [#3270](https://github.com/stella/stella/pull/3270) [`f43eeec`](https://github.com/stella/stella/commit/f43eeecc7013b0deec45f6dbf272abe3da58b813) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A loading button shows only its loader, so a button with its own leading icon no longer spins two icons at once.

## 0.26.2

### Patch Changes

- [#3215](https://github.com/stella/stella/pull/3215) [`e87ce5f`](https://github.com/stella/stella/commit/e87ce5fd3bef938f09fb1db1aae950955ed5919c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep inspector rail scrollbars from narrowing the icon column and show a clear
  resize grip on hover or focus without changing its layout width.

## 0.26.1

### Patch Changes

- [#3141](https://github.com/stella/stella/pull/3141) [`088e15d`](https://github.com/stella/stella/commit/088e15d2cb4c37a1b7f7e5380bbca62ab1704ce2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Temporal for calendar calculations and wall clocks, with a native implementation when available and a bundled fallback otherwise. Preserve serialized timestamps and existing Date-based library interfaces.

## 0.26.0

### Minor Changes

- [#3134](https://github.com/stella/stella/pull/3134) [`8668780`](https://github.com/stella/stella/commit/8668780fbc7ba60ecf40806c79d2b5f6ef1a6b87) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add inline color swatches with an optional custom-color popover, and preserve Escape dismissal from the custom hex input.

## 0.25.2

### Patch Changes

- [#3103](https://github.com/stella/stella/pull/3103) [`60b7e0f`](https://github.com/stella/stella/commit/60b7e0fc3428f1131519c8834c613cef3094a9df) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `Tooltip` and `Popover` keep their popup in normal flow (`relative!`) and size the positioner to it on both axes (`w-max max-w-(--available-width)`, no `--positioner-height`). Base UI's popup viewport writes `position: absolute` inline on the popup for `side="top"` and `side="left"` to anchor size transitions; an out-of-flow popup contributes nothing to a `max-content` positioner, so every tooltip (default `side="top"`) positioned a 0px-wide box: the popup started at the anchor's centre instead of being centred on it, collision shifting never engaged, and a tooltip near the inline end painted past the viewport edge and widened the document.

## 0.25.1

### Patch Changes

- [#2939](https://github.com/stella/stella/pull/2939) [`b36e13f`](https://github.com/stella/stella/commit/b36e13ff49aef6d4fbfd2f476fbad4f3307e975e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Align workspace view tabs with their toolbar and keep action space stable while switching views. Use the subtle scrollbar treatment for inspector content and rail scrolling.

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

- [#2974](https://github.com/stella/stella/pull/2974) [`2ad98a4`](https://github.com/stella/stella/commit/2ad98a402e65877a433eb5061a05f4338b807b38) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustive switches panic on an impossible state instead of rendering a fallback.

## 0.25.0

### Minor Changes

- [#2932](https://github.com/stella/stella/pull/2932) [`56d9efa`](https://github.com/stella/stella/commit/56d9efa4e9c7a958ec2163b3336de494d14ae89e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A kanban band caption now reads as the parent of the columns it groups: its
  line stands on the same row height as the column headers and sets the band's
  name a step heavier than a column title, instead of a shorter line with a
  smaller label that left a group looking subordinate to its own columns. Folded,
  the band's vertical caption keeps that weight.
  `KANBAN_BAND_CAPTION_ROW_HEIGHT` is now the chrome row height.

  A column title also stays readable while its column scrolls past: the swatch,
  the name and the count hold the visible inline edge of a board scrolled
  sideways until the column itself is gone, so the cards under it are never left
  unlabelled. The title travels only as far as the row's own controls, which stay
  at the end of the row, and takes no surface of its own, so the accent a caller
  washes a header cell with goes on painting under it.

  A card's pinned identity row takes a stacking layer, so the positioned controls
  a card carries lower in its own body no longer paint over the name of the card
  they belong to while it scrolls out. The shell's hover actions share that layer
  and still win on tree order; a caller anchoring its own always-visible overlay
  to the same corner now needs a layer of its own.

  `WorkspaceShell` pins its top bar at the new `SHELL_CHROME_LAYER_CLASS_NAME`
  (`z-30`), above the sticky chrome a view pins inside the shell's own scroller.
  A board's header sits at `z-20` and its lane rows at `z-10`; when the shell's
  content column rather than the board is the scroll container, the two used to
  tie on z-index and paint order decided which one covered the other.

### Patch Changes

- [#2930](https://github.com/stella/stella/pull/2930) [`1623392`](https://github.com/stella/stella/commit/1623392d12744ae00bea7f585bed27074dfc9416) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A kanban card's hover-revealed actions no longer sit in the way while they are
  hidden. They took pointer events at rest and stayed visible on pointers that
  cannot hover, which left a small dead zone in the corner of every card: on a
  touch device a press there reached the actions instead of the card, so it never
  started the card's drag. Each pointer now has its own way to them — hover, tab,
  or, for a finger, opening the card, whose actions stay out while it is active.

## 0.24.0

### Minor Changes

- [#2915](https://github.com/stella/stella/pull/2915) [`45b6897`](https://github.com/stella/stella/commit/45b68970d4973ec35676b6c3b4e7ed5e41ff48d7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Kanban board chrome now reads as one tight stack of rows: the column headers
  and every lane's own row share an exported height, and a lane's row is pinned
  on both axes, so its name and what each of its columns holds stay readable all
  the way down the lane. Bands keep their caption at the visible edge while the
  board scrolls sideways, cards can reveal their actions on hover, and the "add a
  card" row is drawn as the card it adds.

- [#2918](https://github.com/stella/stella/pull/2918) [`abe4ff7`](https://github.com/stella/stella/commit/abe4ff770b4efcf1d193e960e5b4d5575bfc11fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A workspace frame that describes neither an end rail nor an inspector now mounts no end dock at all, so its content area runs to the inline-end edge instead of reserving an empty 48px rail.

## 0.23.1

### Patch Changes

- [#2900](https://github.com/stella/stella/pull/2900) [`1e78a6a`](https://github.com/stella/stella/commit/1e78a6abf67d0d4a87015b1db1e86bda34b4f596) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A virtualized cell measures its pinned action before the first paint, so a card's sticky identity row rests under it from the first frame.

## 0.23.0

### Minor Changes

- [#2894](https://github.com/stella/stella/pull/2894) [`ad8ee17`](https://github.com/stella/stella/commit/ad8ee1726c7246487733c3c54653efef49e4573c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A card taller than the board it scrolls through keeps saying which card it is. `KanbanCardShell` takes a `stickyHeader` slot: whatever identifies the card (a code, a title) leads the card, pins under the chrome above it while the rest of the card passes behind it, and releases where the card ends, so the next card's row takes over. The slot is marked `data-kanban-card-sticky-header=""`, repaints the card's own surface over the card's own divider weight, and a card given none renders exactly as before. `KanbanVirtualCell` composes the offset the row rests at: the board's own `KANBAN_STICKY_TOP_VAR` plus the measured height of the cell's pinned action, published per row as `KANBAN_CARD_STICKY_TOP_VAR` (`--kanban-card-sticky-top`) with the virtualizer's own translation taken back out, since a transform between a sticky box and its scroll container is resolved in the translated space.

### Patch Changes

- [#2893](https://github.com/stella/stella/pull/2893) [`35dbb71`](https://github.com/stella/stella/commit/35dbb7146e3214fc99be568c5aa0b06bb8149e2a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Correct invalid utility classes in dialog, input, scroll, and toast primitives.

## 0.22.0

### Minor Changes

- [#2889](https://github.com/stella/stella/pull/2889) [`a7ffd5e`](https://github.com/stella/stella/commit/a7ffd5eadeb4f09e859bb9d0daf95a2ad7bc1a01) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A lane's controls stay reachable while its cells scroll. `KanbanSubgroupBoard` measures its sticky header block and publishes the reach on its scroll container as `KANBAN_STICKY_TOP_VAR` (`--kanban-sticky-top`), so anything that must stay readable rests just under the header and releases where its lane ends. `KanbanVirtualCell` takes `footerPlacement="sticky-start"`, which leads the rows with the `footer` and pins it there instead of closing the cell with it (marked `data-kanban-cell-footer="sticky-start"`, repainting the cell's own surface, accent wash included, over an opaque base so cards pass behind it), and the new `KanbanCollapsedBandCaption` keeps a folded band's name and count in view down a lane hundreds of cards tall. A cell that keeps its own bounded scroll surface is its own scroll container, where the board's header offset means nothing: reset the variable on such a cell so its action rests at the cell's own top.

### Patch Changes

- [#2887](https://github.com/stella/stella/pull/2887) [`f38684c`](https://github.com/stella/stella/commit/f38684c842ac1dd7dca0897a3afa56c80c202e48) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `Popover` and `Tooltip` size their positioner to the rendered popup (`w-max`, still capped by `max-w-(--available-width)`) instead of to `--positioner-width`, and pass an 8px `collisionPadding`. Base UI writes `--positioner-width` from the popup payload, so a popup whose content grew from local state (a picker view swapping to a wide editor view) left the positioner at the old width; Base UI positions and collision-tests the positioner, so `shift()` saw no overflow while the popup rendered wider and ran past the viewport edge. `max-content` also tracks `--popup-width` as it interpolates, so payload transitions keep animating their width and no longer need the variable on the positioner.

## 0.21.0

### Minor Changes

- [#2871](https://github.com/stella/stella/pull/2871) [`c15d115`](https://github.com/stella/stella/commit/c15d1159d9f211d5ac6ce460b3254d927a9f1bc1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - - `@stll/ui/context-menu`: the right-click `ContextMenu` (actions with icons, submenus, separators, a `checked` mark, and `closeOnClick` for toggles) moves from the app into the kit.
  - `SidebarMenuButton` `size="rail"` centres its icon while the sidebar is collapsed: the label leaves the flow instead of only fading out.
  - `KanbanSubgroupBoard` spends one row on an open lane's chrome instead of two: the per-column count row now renders only while a lane is collapsed (an open lane shows its cells, and a folded band's slot carries its own count), and the header and lane paddings tighten.

## 0.20.0

### Minor Changes

- [#2843](https://github.com/stella/stella/pull/2843) [`d5170f5`](https://github.com/stella/stella/commit/d5170f5ea212deee686d5d8d6bfa0a431e2657d6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `InspectorEntityTab` (a rail tab for an open entity: the active tab's icon or a short glyph for every inactive one, with a tooltip and a middle-click close) and its `entityTabGlyph` helper, plus `InspectorFacetBar` (the inspector's overflow-aware row of facet chips) to `@stll/ui/inspector`, so a host can render the same open-entity rail and facet row without rebuilding them locally.

- [#2850](https://github.com/stella/stella/pull/2850) [`1943eed`](https://github.com/stella/stella/commit/1943eed7b652379b67522905518f06b4cd771e36) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `accent` prop to `KanbanVirtualCell` (`@stll/ui/kanban`) so a host can carry a column's option colour onto the cell surface itself, not just its header swatch. With no `accent`, the surface renders exactly as before. With an `accent`, the resting surface gets a faint colour-derived tint, and while `active` is also set (a card dragged over the cell) the tint strengthens into an accent-coloured wash and ring, replacing the generic highlight instead of layering under it.

- [#2845](https://github.com/stella/stella/pull/2845) [`9dd7ff4`](https://github.com/stella/stella/commit/9dd7ff4554ffafc615f5495fd340619576c7a589) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a generic, host-agnostic sidebar shell at `@stll/ui/sidebar`: `SidebarProvider`/`useSidebar` (controlled or uncontrolled open state, mobile sheet, icon-collapse), `Sidebar`, `SidebarHeader`/`Content`/`Footer`/`Separator`, the `SidebarGroup*` family, the `SidebarMenu*` family (with a tooltip shown only while collapsed), `SidebarInset`, `SidebarRail`, `SidebarTrigger`, and the `SIDEBAR_WIDTH_PX`/`SIDEBAR_WIDTH_ICON_PX` size constants.

- [#2854](https://github.com/stella/stella/pull/2854) [`47d3d57`](https://github.com/stella/stella/commit/47d3d5741d51d8b4e70f34cd7ab4535deb12fd0d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `WorkspaceFrame`'s described composition can now render its navigation through the sidebar shell from `@stll/ui/sidebar`. Pass `navigation.sidebar` to get the same collapsible sidebar Stella's own app uses: a header row at toolbar height with a brand slot and a collapse toggle, the described items as sidebar menu buttons with labels while expanded and tooltips while collapsed, and the footer slot below. `open`, `onOpenChange`, `defaultOpen`, and `forceCollapsed` pass through to the sidebar provider so the host owns persistence. Without `navigation.sidebar`, the frame renders the application rail exactly as before.

  `WorkspaceViewSwitcher`'s strip is now one toolbar row (`TOOLBAR_ROW_HEIGHT`), the same height as the frame's top bar and a kanban column header, instead of taking its height from the tabs inside it.

  `SidebarMenuButton` gains `size="rail"`: a 44px target while expanded and while collapsed to the icon rail, for a sidebar that stands in for the application rail.

  `@stll/ui/sidebar` types the custom properties it sets on a local style type instead of a package-private module augmentation, so a consumer compiling the module from source no longer fails on `--sidebar-width`.

## 0.19.0

### Minor Changes

- [#2837](https://github.com/stella/stella/pull/2837) [`df70e4e`](https://github.com/stella/stella/commit/df70e4ee1031c6488686ffe82594e3cb026c5193) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `composer` module (the composer box tokens, `ComposerStatusRow`, `ComposerPicker`, and the send-button and picker-trigger classes) and the `landing` module (`LandingLayout`, `LandingGreeting`, `LandingSection` and its rows), so every home screen and composer surface renders one shell instead of copying its classes.

### Patch Changes

- [#2840](https://github.com/stella/stella/pull/2840) [`b08e83e`](https://github.com/stella/stella/commit/b08e83e935a5078f2b5a771a72c5a8c13750e3d9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A folded kanban band peeks open only while a card is being dragged over it: a plain hover, a column reorder drag, or any other native drag passing over the board no longer opens it, and a board that drives its own drag-and-drop (for example dnd-kit) can now report its drag directly to open the peek instead of relying on native drag events.

- [#2842](https://github.com/stella/stella/pull/2842) [`d751a9c`](https://github.com/stella/stella/commit/d751a9c92ae4f3a6d746b4141e4fe178d49bbfca) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The kanban column header takes the shared chrome row height so column tops align with the rows above them.

## 0.18.0

### Minor Changes

- [#2829](https://github.com/stella/stella/pull/2829) [`6fb442a`](https://github.com/stella/stella/commit/6fb442ad7da2a21f7540e06029086bd04ee559a8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `chip` Button size (a 28px pill at every breakpoint, for chip rows beside a composer) and the `scrollbar-none` utility (a scroll container with no scrollbar and no reserved track). Remove the `scrollbar-hover` utility, which had no remaining consumer.

### Patch Changes

- [#2832](https://github.com/stella/stella/pull/2832) [`af89254`](https://github.com/stella/stella/commit/af89254e3173eec3551f027f12fe1490624670b5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A kanban band folded from its caption no longer peeks straight back open under the resting pointer, and a peeked band stays open while the pointer moves between its caption and its columns instead of folding and reopening on every crossing.

## 0.17.1

### Patch Changes

- [#2805](https://github.com/stella/stella/pull/2805) [`3804984`](https://github.com/stella/stella/commit/380498454502c3593e8c2c84b070c6edaee24321) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Kanban column bands take a caption's height, not a panel's. The band line is
  one 28px row (toggle, swatch, name, count) over a hairline instead of a boxed
  header, bands no longer stretch to the tallest one, and a folded band shows
  only its toggle in that line while its name is set vertically in the narrow
  column body over the count. A folded band peeks open on pointer movement
  inside its slot rather than on entering it, so a band folded under a resting
  pointer stays folded; while it peeks, its caption keeps reporting the band
  collapsed and the toggle pins it open instead of closing it again.

## 0.17.0

### Minor Changes

- [#2794](https://github.com/stella/stella/pull/2794) [`6e437b5`](https://github.com/stella/stella/commit/6e437b5eca2beba037c380a8a7475055df41c0f3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Kanban column bands: a select property's options can belong to named groups,
  and the board shows a group's columns under one band header that folds into a
  single narrow lane.

  - `@stll/workspace-model`: `WorkspacePropertyOptionGroup`, `groups` on a
    select definition and `groupId` on an option, plus
    `resolveWorkspacePropertyOptionGroups`, which lays options out by group in
    sort order and reports an undeclared or split group instead of repairing it.
  - `@stll/ui/kanban`: `KanbanColumnBand` on `KanbanGroupOption` and
    `KanbanGroup`; `resolveKanbanColumnBands` (contiguous runs, rejects a band
    that resumes after another column); `KanbanColumnBandHeader`; and
    `KanbanSubgroupBoard` renders band headers over banded columns, folds a
    collapsed band into one slot per row whose hidden cells stay reachable
    through `renderCollapsedBandCell`, peeks a folded band open while a pointer
    rests on it, and accepts controlled collapse through `isBandCollapsed` /
    `onBandCollapsedChange`. The column width and gap are now exported
    constants.
  - `@stll/workspace-ui`: saved view state `version: 2` adds
    `group.collapsedBands`; `normalizeKanbanSavedViewState` lifts a version 1
    state; `presentKanbanBoard` returns the presented `bands` with the view's
    fold applied; `createWorkspaceKanbanSchema` carries an option's `band`
    through to its column.

## 0.16.1

### Patch Changes

- [#2786](https://github.com/stella/stella/pull/2786) [`0aeaa0f`](https://github.com/stella/stella/commit/0aeaa0f1fab5c562d153dce4338e2c039afb86b6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `InspectorDock` keeps the permanent rail on the pane's inline-start edge, the
  same order as the workspace inspector panel. Collapsed, the rail is still the
  whole dock on the viewport edge; expanded, the pane now opens beyond the rail
  instead of between the content and the rail, so the rail's tabs and toggle
  stay beside the content they describe.

## 0.16.0

### Minor Changes

- [#2770](https://github.com/stella/stella/pull/2770) [`baa8677`](https://github.com/stella/stella/commit/baa86771abbe8e7f50d1ced611a434328a478b3c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `KanbanCellAction`, the shared full-width ghost row that ends a kanban cell with its add action, so every board renders the same footer.

### Patch Changes

- [#2769](https://github.com/stella/stella/pull/2769) [`0e93dee`](https://github.com/stella/stella/commit/0e93deec1bcf1284fe6b61fe24dde916ee53b29d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep combobox, select, and menu item content inside the popup: the content track now shrinks below its content so truncating children clip instead of widening the item.

## 0.15.0

### Minor Changes

- [#2750](https://github.com/stella/stella/pull/2750) [`0751826`](https://github.com/stella/stella/commit/0751826516062111ad9491b95aaad9ee86878a36) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a numeric input with separate editable and canonical values, and keep portal-backed select surfaces readable under dark color schemes.

### Patch Changes

- [#2754](https://github.com/stella/stella/pull/2754) [`23c39cf`](https://github.com/stella/stella/commit/23c39cf74812da26020e97b7c9a9ce12259ea707) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render Kanban boards without a subgroup as a single row of typed cells.

## 0.14.0

### Minor Changes

- [#2733](https://github.com/stella/stella/pull/2733) [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a descriptor-driven workspace frame that owns application navigation and inspector chrome.

### Patch Changes

- [#2732](https://github.com/stella/stella/pull/2732) [`81da3b3`](https://github.com/stella/stella/commit/81da3b39ec8044e9398ee4c01f7bbbdd9a36de36) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose each Kanban swimlane cell's row count to the typed render-cell
  primitive, including explicit zero counts for empty intersections. Add typed
  terminal destination columns to the matrix and drop intent contract.

## 0.13.0

### Minor Changes

- [#2695](https://github.com/stella/stella/pull/2695) [`5a4fa91`](https://github.com/stella/stella/commit/5a4fa911178e25717079e00d048d3a38daf50e7b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow sortable Kanban boards to configure mouse drag activation distance while preserving the default touch and keyboard behavior.

## 0.12.1

### Patch Changes

- [#2661](https://github.com/stella/stella/pull/2661) [`fb97db5`](https://github.com/stella/stella/commit/fb97db59eb4756fd6b0bd82ce42c3016d6946d66) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep flex-based route content stretched inside the workspace shell scroller.

- [#2668](https://github.com/stella/stella/pull/2668) [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the responsive action toolbar for compact workspace controls and allow
  single-purpose shells to omit a compact navigation trigger.

## 0.12.0

### Minor Changes

- [#2635](https://github.com/stella/stella/pull/2635) [`88bf7fb`](https://github.com/stella/stella/commit/88bf7fb898ece322c3b7d2aa015dcb7b5d1da8a8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a card drag surface that preserves embedded controls and scrolling while supporting whole-card drag activation.

- [#2573](https://github.com/stella/stella/pull/2573) [`0b7892b`](https://github.com/stella/stella/commit/0b7892bd9b3b440db2da3604ca05c806d458e98f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Let virtual Kanban cells own typed scroll-element drop targets and their sortable context. Add two-axis keyboard navigation, explicit item or handle activation, outside-board cancellation, overlay stacking, and pointer/touch auto-scroll defaults.

### Patch Changes

- [#2639](https://github.com/stella/stella/pull/2639) [`58c51a3`](https://github.com/stella/stella/commit/58c51a3018ca64ed898e1598b1daba6fe7a71bc8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Drop a Kanban drag on the cell or item the pointer, touch, or keyboard actually reached. dnd-kit computes collisions while rendering but publishes the resulting drop target a render later, and resolves a drop from that published value; because a single move produces a single render, a drag that ended right after its last move landed the item on the previous target. Every board sensor now waits for the published target to match the computed collision before ending the drag.

  Keyboard navigation to a row a virtual cell has not mounted yet is held to the same rule: ending while that row is still being scrolled into view waits for it rather than committing the row the drag had left, and cancels instead of dropping somewhere the user never navigated to if the board cannot reach it.

- [#2642](https://github.com/stella/stella/pull/2642) [`00bd34d`](https://github.com/stella/stella/commit/00bd34d7b6d4204749730813ae2cde4a2e82047e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Restore keyboard card dragging and preserve nested control input events.

## 0.11.1

### Patch Changes

- [#2589](https://github.com/stella/stella/pull/2589) [`1e696fb`](https://github.com/stella/stella/commit/1e696fbccf05cd26b899c161952c81ae323c4b80) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep Select's derived label callback stable across parent renders.

## 0.11.0

### Minor Changes

- [#2596](https://github.com/stella/stella/pull/2596) [`c56a0c7`](https://github.com/stella/stella/commit/c56a0c7e97ef276b1353a7621e4658b2d9f2ada0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Make responsive navigation ownership explicit in `WorkspaceShell`, with a shell-managed compact sheet contract for hosts that do not already provide responsive navigation.

## 0.10.0

### Minor Changes

- [#2594](https://github.com/stella/stella/pull/2594) [`37b6437`](https://github.com/stella/stella/commit/37b64377f9806be3da0a9cf9b33e7b984e46ed1a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Replace the partial application frame with a complete fixed-viewport workspace shell and permanent typed end rail. This pre-1.0 breaking minor requires navigation, sticky top chrome, and an inline-end dock; chat must be wired or explicitly unavailable.

## 0.9.1

### Patch Changes

- [#2561](https://github.com/stella/stella/pull/2561) [`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve a board's group identifier union through grouping, saved-view, picker, and atomic drop-intent APIs.

## 0.9.0

### Minor Changes

- [#2533](https://github.com/stella/stella/pull/2533) [`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add typed Group and Sub-group board matrices, reusable swimlane and virtual-cell renderers, atomic drop intents, and persisted board-presentation adapters.

## 0.8.0

### Minor Changes

- [#2551](https://github.com/stella/stella/pull/2551) [`7c0d6fb`](https://github.com/stella/stella/commit/7c0d6fb9003b917202449450bdfd7362d4089bfb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add reusable inspector tabs and compact application rails that share stella's dock sizing, scroll ownership, and sidebar control rhythm.

- [#2528](https://github.com/stella/stella/pull/2528) [`9c2cc2d`](https://github.com/stella/stella/commit/9c2cc2daff89dda2cc2508e2c1dca6bde834dc57) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export a shared ordered control-size contract and use it consistently across text inputs, textareas, selects, comboboxes, and command inputs.

### Patch Changes

- [#2538](https://github.com/stella/stella/pull/2538) [`a4062b2`](https://github.com/stella/stella/commit/a4062b260031fe8fda587ea7e8bf2e2841349523) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow application shell content to shrink within its flex layout.

## 0.7.0

### Minor Changes

- [#2524](https://github.com/stella/stella/pull/2524) [`746d6f3`](https://github.com/stella/stella/commit/746d6f3ecee8e92aa433bc4b30c5507ed5e3bb53) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the shared review chrome: status badge, severity dot, decision actions, comment card, author avatar, out-of-date notice, and diff text.

- [#2530](https://github.com/stella/stella/pull/2530) [`62e2d3e`](https://github.com/stella/stella/commit/62e2d3eda8809f5cd6996cb6e3b1515cd18da1f2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an `ApplicationShell` primitive for application navigation, page chrome, and optional inspector layouts.

## 0.6.0

### Minor Changes

- [#2502](https://github.com/stella/stella/pull/2502) [`26acf32`](https://github.com/stella/stella/commit/26acf32c18edbcd71ebc3f29ba2999676bc90390) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add accessible sortable-board primitives with pointer, touch, and keyboard input support.

- [#2431](https://github.com/stella/stella/pull/2431) [`7f66d10`](https://github.com/stella/stella/commit/7f66d10919fee6037d16fac69a1dff08125cffb8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `Loader` and `LoaderState` primitives for indeterminate loading states, and restore bordered inspector rail tabs.

## 0.5.2

### Patch Changes

- [#2412](https://github.com/stella/stella/pull/2412) [`e152e00`](https://github.com/stella/stella/commit/e152e00d04ec923758e5cece8033c46f87469c48) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render inspector rail tabs as canonical square active chips.

## 0.5.1

### Patch Changes

- [#2345](https://github.com/stella/stella/pull/2345) [`3bf2e63`](https://github.com/stella/stella/commit/3bf2e63080436a16dad0a46958049850ec5831c4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `use-latest` export; migrate internal render-body ref mirrors to it so affected components stay React Compiler-compatible.

## 0.5.0

### Minor Changes

- [#2327](https://github.com/stella/stella/pull/2327) [`f43667b`](https://github.com/stella/stella/commit/f43667bfa8dccca5f4c4e622bf6f80972ed349d6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an entity-agnostic data-table renderer with empty, loading, and accessible row-action states.

## 0.4.0

### Minor Changes

- [#2300](https://github.com/stella/stella/pull/2300) [`77825df`](https://github.com/stella/stella/commit/77825dfdee54a9d3b065afa3b5504aaa55050bd8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export entity-agnostic calendar primitives and a resource calendar with half-open date-range placement.

- [#2297](https://github.com/stella/stella/pull/2297) [`d2dcd0f`](https://github.com/stella/stella/commit/d2dcd0f1df22dffc91ba779e6c278b18825f1932) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the kanban card drag lifecycle and horizontal board auto-scroll from
  `@stll/ui/kanban`. Card payloads and drop persistence stay with the application;
  the package owns the shared drag preview and overflow-boundary behaviour. The
  Atlaskit v3 is a peer contract, so drag sources, targets, and monitors share one
  adapter instance.

## 0.3.0

### Minor Changes

- [#2266](https://github.com/stella/stella/pull/2266) [`5388db6`](https://github.com/stella/stella/commit/5388db63ae1c431da728845f4ae5d1f89f927e18) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the kanban board's grouping and the option-colour token.

  `@stll/ui/kanban` carries the board's column resolution and its two pieces of
  chrome. A board's columns come from a schema the caller supplies: the properties
  it may group by, plus built-in group resolvers for columns that come from
  somewhere other than a property. The module reads nothing off a row, so what a
  row is stays entirely with the caller. Alongside it, `KanbanCardShell` holds the
  card's border, hover lift, active ring and drag wrapper, and
  `KanbanColumnHeader` holds the header row's rhythm; a card that opens nothing
  gets neither a button role nor a tab stop.

  `@stll/ui/option-color` is the colour token user-chosen options are stored as:
  one of sixteen named presets resolving to the theme's `--option-*` custom
  properties, or a hex string resolving to a `color-mix` against the current
  background. The indirection is what keeps a stored colour theme-aware, and the
  resolver had been written out twice outside the package.

- [#2276](https://github.com/stella/stella/pull/2276) [`2f7f773`](https://github.com/stella/stella/commit/2f7f773f8b9c0a14511a796a40821a35943b3b13) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the data table's column schema.

  `@stll/ui/data-table` describes what a table's columns are, independent of how
  they draw: an ordered list of descriptors, each with an id, a label, a starting
  width, its capabilities (sort, hide, resize, pin) and an emphasis. Nothing in it
  looks inside a descriptor's render payload, so a caller keeps its own
  exhaustively checked union there and the schema stays free of any idea about
  what a row holds.

  Two rules belong to the schema rather than to a renderer: a column that cannot
  be hidden stays visible whatever the stored hidden list says, so a stale list
  cannot strand a table without its selection column; and `duplicateColumnIds`
  reports a repeated id, which would otherwise drop a column silently because the
  table keys by id.

### Patch Changes

- [#2272](https://github.com/stella/stella/pull/2272) [`794eca0`](https://github.com/stella/stella/commit/794eca0b7d4d615d78f899b1629eff21831bd530) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Outline rail entries take an optional `title`, rendered after a non-truncating label; `meta` stays right-pinned. The tooltip shows both.

- [#2271](https://github.com/stella/stella/pull/2271) [`314a468`](https://github.com/stella/stella/commit/314a4685593298e63f017c466125b7348f9f9858) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Toggling an outline rail branch keeps the toggled row where it was instead of re-pinning it to its sticky offset.

## 0.2.0

### Minor Changes

- [#2260](https://github.com/stella/stella/pull/2260) [`9c7604a`](https://github.com/stella/stella/commit/9c7604a144b2566b0b27b0d81ba6c2d2cd63f213) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the design system as a versioned package with an explicit export map.

  `@stll/ui` was a private workspace whose `exports` were wildcards over `./src`,
  so nothing checked that a module belonged in the design system: the boundary
  between reusable primitive and application code was a convention. It now
  declares one flat subpath per module — `@stll/ui/button`, `@stll/ui/use-mobile`,
  `@stll/ui/utils`, `@stll/ui/inspector` — plus `sideEffects: false` and peer
  dependencies on React, Base UI, and Tailwind, and builds with tsdown to one
  output module per source module with declarations.

  The grouped subpaths `@stll/ui/components/<name>`, `@stll/ui/hooks/<name>`, and
  `@stll/ui/lib/<name>` are deprecated. They still resolve to the same modules
  and will be removed after this minor.

  `@stll/ui/theme.css` is now the only stylesheet the package exports: the token
  map, the palettes, the base layer, and the custom utilities. No compiled CSS
  ships, and each application owns its own Tailwind entry rather than importing a
  repository-specific one from the package. The dockable inspector pane is a
  module of the package (`@stll/ui/inspector`) rather than markup and arithmetic
  spread across route files.
