# @stll/workspace-ui

## 0.24.6

### Patch Changes

- [#9535](https://github.com/stella/stella/pull/9535) [`3493d33`](https://github.com/stella/stella/commit/3493d33c38d730aaa95c8ca624b9a54fdea3d23c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `SidebarProvider`, `DetailsGrid`, `EntityActions`, the native `Sheet` and `ConditionBuilder` keep their context values stable across renders, so a re-render of the provider no longer re-renders every consumer in an app that does not use the React Compiler.
- Updated dependencies [[`4d9d313`](https://github.com/stella/stella/commit/4d9d3134c132a0b3c005588624a0dd4096a1f358), [`e034ab2`](https://github.com/stella/stella/commit/e034ab28a81e2cfba784c523e00eb20ca17f3b12), [`f51823e`](https://github.com/stella/stella/commit/f51823ed31394c53538533189b9284af3e484cb0), [`e335127`](https://github.com/stella/stella/commit/e335127269927db46c6035451c66d782ef3af5bc), [`2902ea2`](https://github.com/stella/stella/commit/2902ea2475ee03df9c16889783684686a56ca2f1), [`611c27e`](https://github.com/stella/stella/commit/611c27ee631640a3826786e5da7bc734d6d563df), [`bc0782b`](https://github.com/stella/stella/commit/bc0782b934613f4d8f84d27eb8830f9de8780ed9), [`353fefb`](https://github.com/stella/stella/commit/353fefbfd02ba80646edff6738ad364384d0df51), [`3493d33`](https://github.com/stella/stella/commit/3493d33c38d730aaa95c8ca624b9a54fdea3d23c), [`be9916a`](https://github.com/stella/stella/commit/be9916ac9072029fc77096077be4ce01d7ee0ef3), [`b135cba`](https://github.com/stella/stella/commit/b135cbac718fc41005de7c88cb91878ac588f747)]:
  - @stll/ui@0.90.0

## 0.24.5

### Patch Changes

- Updated dependencies [[`8560c3c`](https://github.com/stella/stella/commit/8560c3c53934377d434c41270ace8fe175f0190a), [`1642faf`](https://github.com/stella/stella/commit/1642faf23e5cf48f6cf3c719c9b251ac786c8d5e)]:
  - @stll/ui@0.89.0

## 0.24.4

### Patch Changes

- Updated dependencies [[`1ab906c`](https://github.com/stella/stella/commit/1ab906cc4ad7916de5ef21284416343ea2e2810c)]:
  - @stll/ui@0.88.0

## 0.24.3

### Patch Changes

- Updated dependencies [[`1798f66`](https://github.com/stella/stella/commit/1798f6615a61ddf02e091d925269ed735bef75fe)]:
  - @stll/ui@0.87.0

## 0.24.2

### Patch Changes

- Updated dependencies [[`b280d21`](https://github.com/stella/stella/commit/b280d21b8b6bc7149a342a08f2d78036f1099186)]:
  - @stll/ui@0.86.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`6bc0546`](https://github.com/stella/stella/commit/6bc0546997b8d2bec84322aebee4c8249415af63), [`e1d953a`](https://github.com/stella/stella/commit/e1d953a644572aabd221066d6b567d05f17cbb5b)]:
  - @stll/ui@0.85.0

## 0.24.0

### Minor Changes

- [#9246](https://github.com/stella/stella/pull/9246) [`f292e0a`](https://github.com/stella/stella/commit/f292e0af50fa6912cdced0f28f0b4cfd22c61c01) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `FileConversionRefusal` adds `{ kind: "no_preview", format, cause }`: an image this deployment makes no preview of, because it does not decode the format (`"decoding_off"`) or cannot read the file's pictures (`"unreadable"`). `format` is the file's short tag, such as `"HEIC"`.

### Patch Changes

- Updated dependencies [[`98abe28`](https://github.com/stella/stella/commit/98abe2841a69b052cdfd34cfd8e42fe5d7a53105)]:
  - @stll/ui@0.84.1

## 0.23.3

### Patch Changes

- Updated dependencies [[`06795f2`](https://github.com/stella/stella/commit/06795f299fc300e130bd3c92a749e01ecf4c0853)]:
  - @stll/ui@0.84.0

## 0.23.2

### Patch Changes

- Updated dependencies [[`10ef464`](https://github.com/stella/stella/commit/10ef464329c555633c59a8307bbd6bf85e22fe5a)]:
  - @stll/ui@0.83.0

## 0.23.1

### Patch Changes

- Updated dependencies [[`39eabb8`](https://github.com/stella/stella/commit/39eabb8eee2640bdda32e928239460602aefc23b)]:
  - @stll/ui@0.82.0

## 0.23.0

### Minor Changes

- [#9193](https://github.com/stella/stella/pull/9193) [`94387e7`](https://github.com/stella/stella/commit/94387e7ca464e5f26cf95913f20b0a4a503b79b9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `@stll/ui/inline-overflow` holds the policy that decides which items of a single-line row fit and which move into a trailing "show more" menu (`resolveInlineOverflow`, `splitInlineOverflow`), and `@stll/ui/use-inline-overflow` measures a row for it. `InspectorFacetBar` runs on them. `WorkspaceViewSwitcher` takes a required `overflowLabel` and moves the views that do not fit into a menu after the tabs, keeping the active or renamed view on screen, instead of scrolling the tabs; the strip's add control no longer draws a divider.

### Patch Changes

- Updated dependencies [[`9db6ee1`](https://github.com/stella/stella/commit/9db6ee1cbde7b4e6b85210e46bf93c705034e64b), [`94387e7`](https://github.com/stella/stella/commit/94387e7ca464e5f26cf95913f20b0a4a503b79b9), [`7192259`](https://github.com/stella/stella/commit/7192259afbb8e3e3ffbbb906b9be3129e1ab3882), [`f55e84a`](https://github.com/stella/stella/commit/f55e84a17a4847c2d6722799990f5932fdd7b004), [`62c29aa`](https://github.com/stella/stella/commit/62c29aa31dfa732c9962227ae90b54ccb4bddbd6), [`b0f575f`](https://github.com/stella/stella/commit/b0f575f1ef2b403299e222e2dc21293b916785c7)]:
  - @stll/ui@0.81.0

## 0.22.0

### Minor Changes

- [#9081](https://github.com/stella/stella/pull/9081) [`d357728`](https://github.com/stella/stella/commit/d357728224fb93f2fda81a1fb619a2f6f7fe5557) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Buttons expose the disabled reason as an accessible description and retain keyboard focus when it changes. A disabled inline text run requires a reason. File, search, and secret inputs accept a localized `disabledReason` for their action buttons. Split buttons use `primaryDisabledReason` for their primary action. Review controls use `disabledReason`, `applyingReason`, or `actionDisabledReason` to explain pending and restricted decisions.

  Condition builder labels now include `noFields` and `groupFull` to explain why a condition or group cannot be added.

### Patch Changes

- Updated dependencies [[`d357728`](https://github.com/stella/stella/commit/d357728224fb93f2fda81a1fb619a2f6f7fe5557)]:
  - @stll/ui@0.80.0

## 0.21.2

### Patch Changes

- Updated dependencies [[`2d31b6d`](https://github.com/stella/stella/commit/2d31b6d446bf6c1a38c09d27d0b56456dcbed015)]:
  - @stll/ui@0.79.0

## 0.21.1

### Patch Changes

- Updated dependencies [[`b6194a7`](https://github.com/stella/stella/commit/b6194a73bae3624e7afb0f8a6b21ac9facdb97f8)]:
  - @stll/ui@0.78.0

## 0.21.0

### Minor Changes

- [#9017](https://github.com/stella/stella/pull/9017) [`25a0c38`](https://github.com/stella/stella/commit/25a0c386561c724d1c7cc0100c7a0a08c2e39b24) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the width every kanban board column takes (`KANBAN_COLUMN_WIDTH_CLASS`) from `@stll/ui/kanban-column-header-shell`, so a loading view can lay its column headers out where the board will. `WorkspaceViewSwitcherFace` takes an optional `renderName` for a tab name the caller draws itself.

- [#9005](https://github.com/stella/stella/pull/9005) [`47c898e`](https://github.com/stella/stella/commit/47c898e35450bb16260efaef0bf1144cd59a355d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add loading faces for a select trigger and a segmented icon toggle to `@stll/ui/control-face`, and for the view filter button and chip to `@stll/ui/view-toolbar-shell`, each built from the same classes as the control it stands in for. Add `@stll/workspace-ui/sorts-face`, the sort chips' loading face.

### Patch Changes

- Updated dependencies [[`ebe8ae8`](https://github.com/stella/stella/commit/ebe8ae88a7847490bc6d40153ab3a80a97cebc4e), [`be836e0`](https://github.com/stella/stella/commit/be836e098b22eb7fc70661f150c0dfc11c6a3220), [`e7a4e0c`](https://github.com/stella/stella/commit/e7a4e0c73395c7481f051aefb03a2306bbf1f5ef), [`10a2406`](https://github.com/stella/stella/commit/10a2406e96662f08eb556a0155676732d511cdfc), [`37117f6`](https://github.com/stella/stella/commit/37117f6e007640ac3eeff769935081020d49ad74), [`c3b4e95`](https://github.com/stella/stella/commit/c3b4e95a62d63062c0013dc3d8c8fbb79c6d3cbf), [`25a0c38`](https://github.com/stella/stella/commit/25a0c386561c724d1c7cc0100c7a0a08c2e39b24), [`47c898e`](https://github.com/stella/stella/commit/47c898e35450bb16260efaef0bf1144cd59a355d), [`4a564f6`](https://github.com/stella/stella/commit/4a564f686b8ee215910fcfa46860fb2e1f06086b), [`846c016`](https://github.com/stella/stella/commit/846c016a47690b5c6c88db2f78881aa68758668a), [`036acf9`](https://github.com/stella/stella/commit/036acf965aae01184cee165c28dd8d7c0a4443b9), [`6d0d7f7`](https://github.com/stella/stella/commit/6d0d7f79e8792da0ef60232ce75cf98b6ee204b0), [`47c898e`](https://github.com/stella/stella/commit/47c898e35450bb16260efaef0bf1144cd59a355d)]:
  - @stll/ui@0.77.0

## 0.20.0

### Minor Changes

- [#8963](https://github.com/stella/stella/pull/8963) [`c2cddf2`](https://github.com/stella/stella/commit/c2cddf2c635ac648c258913fc9c51d2d4fa9d225) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Light modules for loading views drawn before the page mounts. `@stll/ui/truncated-text-face` holds `TruncatedTextFace` and the line classes `TruncatedText` is built from, with no tooltip or popover. `@stll/ui/view-toolbar-shell` holds `ViewChromeBar` and `ViewToolbarChrome`, which `@stll/ui/view-toolbar` re-exports. `@stll/workspace-ui/view-strip` holds the view strip, its tab face and `WorkspaceViewSwitcherFace`, whose tab names are now faces with no hint; `@stll/workspace-ui/view-switcher-face` re-exports them beside `WorkspaceViewTabName`. A strip's `direction` is optional and follows the document when left out.

- [#8894](https://github.com/stella/stella/pull/8894) [`a6c1f0f`](https://github.com/stella/stella/commit/a6c1f0fb49c74499b19c1e2d8c9e7fbe210a3517) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `@stll/workspace-ui/view-switcher-face`: `WorkspaceViewSwitcherFace` draws the saved-view strip without its behaviour, for a loading view, and `WorkspaceViewStrip` and `WorkspaceViewTabFace` are the row and tab both switchers share.

### Patch Changes

- [#8880](https://github.com/stella/stella/pull/8880) [`1f4ee37`](https://github.com/stella/stella/commit/1f4ee37011a600e45f2c4b4204ac25688e5a372f) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update `tldts` to `7.5.2`.
  Update `lucide-react` to `1.72.0`.
  Update `use-intl` to `4.15.1`.
- Updated dependencies [[`86022ca`](https://github.com/stella/stella/commit/86022ca85d6a2d92a262628f29d720d5a0e1eb03), [`f8831e4`](https://github.com/stella/stella/commit/f8831e47629b27bdcaf4041f19b8196b6d30dab5), [`3d7121a`](https://github.com/stella/stella/commit/3d7121a5dfe6b34b74729dea7157b33f0a5d171a), [`1f4ee37`](https://github.com/stella/stella/commit/1f4ee37011a600e45f2c4b4204ac25688e5a372f), [`b261ece`](https://github.com/stella/stella/commit/b261ece00959cc1349dec67471de4b46e2009fec), [`6709183`](https://github.com/stella/stella/commit/67091834bf8af1291247c7be3f5540d311167ead), [`1f24eba`](https://github.com/stella/stella/commit/1f24eba240c916800932ff33c288521f32b539e3), [`e82f6b6`](https://github.com/stella/stella/commit/e82f6b6a289f2a9e6d01f60b5f7cacb29ce57d1c), [`c2cddf2`](https://github.com/stella/stella/commit/c2cddf2c635ac648c258913fc9c51d2d4fa9d225), [`f6360bf`](https://github.com/stella/stella/commit/f6360bff82e3a13fcaa16dc85db2097f1300c9c9), [`efaf23f`](https://github.com/stella/stella/commit/efaf23fe907e7596cc676851985b4a90f9882e57), [`c2cddf2`](https://github.com/stella/stella/commit/c2cddf2c635ac648c258913fc9c51d2d4fa9d225)]:
  - @stll/ui@0.76.0

## 0.19.0

### Minor Changes

- [#8846](https://github.com/stella/stella/pull/8846) [`e8aa798`](https://github.com/stella/stella/commit/e8aa7988f19952963102e45c4a95af1005045437) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `WorkspaceShell` takes an optional `skipToContentLabel`. When set, the shell renders a visually hidden skip link as its first tab stop that moves focus to the main region. `WorkspaceFrame` passes it through in the `host-responsive` composition.

### Patch Changes

- [#8618](https://github.com/stella/stella/pull/8618) [`e229034`](https://github.com/stella/stella/commit/e22903462cf3734c29b0a97f2f48dc3023e758c8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Ship with the refreshed catalog dependencies: lucide-react 1.71.0 for `@stll/ui` and use-intl 4.14.10 for `@stll/workspace-ui`.
- Updated dependencies [[`9083d12`](https://github.com/stella/stella/commit/9083d12e2b853c009066c81117fea294e3b548dc), [`9e0fd52`](https://github.com/stella/stella/commit/9e0fd526ef113a0ccf90546b8ef92ea5fff36318), [`e229034`](https://github.com/stella/stella/commit/e22903462cf3734c29b0a97f2f48dc3023e758c8), [`54d4095`](https://github.com/stella/stella/commit/54d409572d79298687864e424ed8dd555ea075e2), [`0dad4da`](https://github.com/stella/stella/commit/0dad4da417b4a99c6141363e2c05a757a314fb72), [`7c534ed`](https://github.com/stella/stella/commit/7c534ed29c09e58efc43fcb3d985941eb52e12b6), [`e8aa798`](https://github.com/stella/stella/commit/e8aa7988f19952963102e45c4a95af1005045437)]:
  - @stll/ui@0.75.0

## 0.18.4

### Patch Changes

- Updated dependencies [[`178d3f9`](https://github.com/stella/stella/commit/178d3f9f9007de5933b40fd76f8bbaaf65ad089f), [`d8eea73`](https://github.com/stella/stella/commit/d8eea7352a0a6cdeac6498e6231a17818e8cd2d2), [`f6d0e9c`](https://github.com/stella/stella/commit/f6d0e9c9d9966961d52a3d8038a253193632ef2b), [`b1ce389`](https://github.com/stella/stella/commit/b1ce389d73729179bd174166e78499310331479e), [`6359411`](https://github.com/stella/stella/commit/6359411768fbe352d04d63ead41386de9e70137b), [`b9120cd`](https://github.com/stella/stella/commit/b9120cd4f32b6019e3e1db42309ac50960badf2f)]:
  - @stll/ui@0.74.0

## 0.18.3

### Patch Changes

- Updated dependencies [[`501e484`](https://github.com/stella/stella/commit/501e48459f95e38d4594eff47b6daf2040380582), [`64d8cfd`](https://github.com/stella/stella/commit/64d8cfd04b20823f8f8ceabb9dbd0d79bf76ee66), [`c6f510f`](https://github.com/stella/stella/commit/c6f510fb3b4fe3ebcb8a3c761d623dd13cc53c63)]:
  - @stll/ui@0.73.0

## 0.18.2

### Patch Changes

- [#8537](https://github.com/stella/stella/pull/8537) [`001c640`](https://github.com/stella/stella/commit/001c640e64cb00e3948bdf68a18a40347c65a40f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build declarations through the native tsrs API supported by tsdown 0.23.7, resolving the compiler from each package.
- Updated dependencies [[`c115c6c`](https://github.com/stella/stella/commit/c115c6cf21780277c98908cbd26a8bb5f279591f), [`7b112d3`](https://github.com/stella/stella/commit/7b112d309728e72aa60d00c8c5d120f83aff698c), [`7600aee`](https://github.com/stella/stella/commit/7600aee38e07fc7f5956849dd6619e547f3fe400), [`001c640`](https://github.com/stella/stella/commit/001c640e64cb00e3948bdf68a18a40347c65a40f), [`001c640`](https://github.com/stella/stella/commit/001c640e64cb00e3948bdf68a18a40347c65a40f), [`617b308`](https://github.com/stella/stella/commit/617b308dc6d81b9d5cfb15395de717419afcff99), [`f6326a3`](https://github.com/stella/stella/commit/f6326a3fbfbbdadaa8839b122e162249ea42ec54)]:
  - @stll/ui@0.72.0
  - @stll/calculations@0.1.5
  - @stll/conditions@0.4.1

## 0.18.1

### Patch Changes

- Updated dependencies [[`7ac6369`](https://github.com/stella/stella/commit/7ac63690af36c69a3e80e14ebf738a911fbb578d), [`64b1a13`](https://github.com/stella/stella/commit/64b1a130fc710feaeb068e9f971a035b237b7eb0), [`7e56257`](https://github.com/stella/stella/commit/7e5625775367ae55b8719fe9a7dabbd79edc9688)]:
  - @stll/ui@0.71.0

## 0.18.0

### Minor Changes

- [#7621](https://github.com/stella/stella/pull/7621) [`010b3cb`](https://github.com/stella/stella/commit/010b3cb50b5f12466dcc81ba387a4765cb1184ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep text that does not fit inside its container, and show the whole of it on hover, focus or tap only where it is actually cut.

  `@stll/workspace-ui/field-value` no longer exports `getIntClassName`: numeric field values render through `NumericFieldText`, which cuts them with `TruncatedText`.

  `@stll/ui` widens `TruncatedText` (more `lines` values and a `hint` switch) and changes `COMPOSER_PLACEHOLDER_CLASS`; the composer placeholder renders through the new `ComposerPlaceholder`.

### Patch Changes

- Updated dependencies [[`53ddfb1`](https://github.com/stella/stella/commit/53ddfb1619d4b2d41e5cdc4fd88699a5077e8606), [`010b3cb`](https://github.com/stella/stella/commit/010b3cb50b5f12466dcc81ba387a4765cb1184ce), [`8997182`](https://github.com/stella/stella/commit/899718207e93ac2ed8cab63ea022f595d5b5ad02)]:
  - @stll/ui@0.70.0

## 0.17.1

### Patch Changes

- Updated dependencies [[`a168fa2`](https://github.com/stella/stella/commit/a168fa2b2fcd5ac1f63b0d47f4f4ecfe9f3dc0e7), [`c98d90f`](https://github.com/stella/stella/commit/c98d90f08913deef444adcc8e821f16ecd9ce7f6), [`7f4b66d`](https://github.com/stella/stella/commit/7f4b66d3518d62c6da22fbfb89517ef8c14ec40b), [`fdc86ae`](https://github.com/stella/stella/commit/fdc86ae113bd086fda0d174b200f59dce7abeaa1), [`e7d8040`](https://github.com/stella/stella/commit/e7d80400c14af980d49c15ca0555e21bc8e78534)]:
  - @stll/ui@0.69.0

## 0.17.0

### Minor Changes

- [#6940](https://github.com/stella/stella/pull/6940) [`704ca22`](https://github.com/stella/stella/commit/704ca22912cd096ae056e181286e4a7aefc03064) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Corner radii name a scale step: bare `rounded` is now `rounded-sm`, and the checkbox, segmented toggle and input-group keycap use scale steps instead of pixel radii. `--radius` is 0.5rem. Light text is neutral-900, dark muted text neutral-400, and sidebar text is stronger in both themes.

  `@stll/workspace-ui`: `./field-value#getIntClassName` returns the kanban class string with `rounded-sm` in place of `rounded`, so its literal return type changes.

### Patch Changes

- [#7924](https://github.com/stella/stella/pull/7924) [`8bcf336`](https://github.com/stella/stella/commit/8bcf336068af58ccb4a28150967aa128e586ba88) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update compatible runtime dependencies: `@stll/time` 0.4.2, `temporal-polyfill` 1.0.6, `lucide-react` 1.65.0, Tiptap 3.32.1 and the MCP client 2.4.0.
- Updated dependencies [[`8bcf336`](https://github.com/stella/stella/commit/8bcf336068af58ccb4a28150967aa128e586ba88), [`26a454c`](https://github.com/stella/stella/commit/26a454c7de75da7fabf3ac4c7746e68f09bdb1a1), [`3978f45`](https://github.com/stella/stella/commit/3978f45cea7b4a37d42882f1be9075ea933d2f39), [`ad81543`](https://github.com/stella/stella/commit/ad81543e9c85c79cc921caa5b72d7ee39cde94c3), [`5afd089`](https://github.com/stella/stella/commit/5afd0899278f2dd459ad8789b7d8b94d6e1de2c5), [`faad54b`](https://github.com/stella/stella/commit/faad54bc23ee324f40fbcffa36094197fd2a0b1d), [`704ca22`](https://github.com/stella/stella/commit/704ca22912cd096ae056e181286e4a7aefc03064), [`e06b815`](https://github.com/stella/stella/commit/e06b81538abe018cd8015a5ba2732e84981ff9a2)]:
  - @stll/ui@0.68.0
  - @stll/money@0.4.0
  - @stll/calculations@0.1.4

## 0.16.0

### Minor Changes

- [#7941](https://github.com/stella/stella/pull/7941) [`c06a3b7`](https://github.com/stella/stella/commit/c06a3b75576febd3108abf6c769c62ecf5d47624) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `record` field content type: a cell holding typed records from a data source or a structured AI answer. `FieldValue` renders it as a summary (the record's values, a record count, a prompt to choose among unselected candidates, or a review or not-found note), and `RecordFieldValue`, `summarizeRecordField` and the `RecordField*` types are exported. `GenericProperty` and `PropertyIconType` accept `record`.

### Patch Changes

- Updated dependencies [[`4c623bb`](https://github.com/stella/stella/commit/4c623bbc19a13167e06f819783849e10c8cbddc0), [`61932c3`](https://github.com/stella/stella/commit/61932c325b3ce81881dbd917961a301891b7d949), [`50c904c`](https://github.com/stella/stella/commit/50c904c50877280367403165f00ef5d92663b23c), [`fa90f18`](https://github.com/stella/stella/commit/fa90f18c69c45e42359e2c5dc2e4511bf69466df), [`b137d1b`](https://github.com/stella/stella/commit/b137d1b048e6d36123ba60d24ab99baaf8208de7)]:
  - @stll/ui@0.67.0

## 0.15.8

### Patch Changes

- [#7427](https://github.com/stella/stella/pull/7427) [`d05a124`](https://github.com/stella/stella/commit/d05a124a296d0426288f86684f0c77c1b1072db4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `ChatModelSelector` now renders the `@stll/ui` select (a button and a popup list) instead of a native `<select>`: a host must load the `@stll/ui` stylesheet (`@stll/ui/theme.css` with Tailwind scanning `@stll/ui`) for it to draw. `ChatLink` shows its new-tab notice or source title as a tooltip and as the link's accessible description. The condition builder's number fields use `NumberInput` without locale grouping.
- Updated dependencies [[`21f18d7`](https://github.com/stella/stella/commit/21f18d7eae6c328149c77ebf2a1baff624de33c6), [`e5ee9a9`](https://github.com/stella/stella/commit/e5ee9a9c120441b0bea4476df78e1432ace3146d), [`254bf05`](https://github.com/stella/stella/commit/254bf058b481c2ea137f8e37664a37b80c537190), [`72b68c8`](https://github.com/stella/stella/commit/72b68c8fc423618a9e060ead157dc3f2f30e1583)]:
  - @stll/ui@0.66.0

## 0.15.7

### Patch Changes

- [#7844](https://github.com/stella/stella/pull/7844) [`f630d4c`](https://github.com/stella/stella/commit/f630d4c14cffb0b8e8ccef327601ba4d2760c217) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `ViewSwitcher` renders view names isolated and without directional controls.
- Updated dependencies [[`b94d282`](https://github.com/stella/stella/commit/b94d282e58eb483f7abf6cc7e81b859c7709ce3b)]:
  - @stll/ui@0.65.0

## 0.15.6

### Patch Changes

- Updated dependencies []:
  - @stll/ui@0.64.0

## 0.15.5

### Patch Changes

- Updated dependencies []:
  - @stll/ui@0.63.0

## 0.15.4

### Patch Changes

- Updated dependencies [[`adf1c80`](https://github.com/stella/stella/commit/adf1c80ebf26167d25ca898c5a84ab2ec7f3f7df), [`8c6d81b`](https://github.com/stella/stella/commit/8c6d81bce91505c9adb7a4ce110e59ca9f14d995), [`1a9cfef`](https://github.com/stella/stella/commit/1a9cfefef3dffb7d7dd7b719b274a3a17038a7d3), [`2d19088`](https://github.com/stella/stella/commit/2d19088ff7e50ef7c05626cb0acea99d833ee040), [`9a630f2`](https://github.com/stella/stella/commit/9a630f22434730827a062f801da6dba99c1ff470), [`d606df6`](https://github.com/stella/stella/commit/d606df66432d07b47ffac383ef63489f7a3d881f), [`18d7fab`](https://github.com/stella/stella/commit/18d7fabf3c8b36d91f3520e327a4ebae17f5cee0), [`d9f4906`](https://github.com/stella/stella/commit/d9f49066d72b5e611e7ab38b3d041a87bb252d28), [`e88b3ff`](https://github.com/stella/stella/commit/e88b3fff72fa8bcf7c81a66c54b58c425ab1fee7)]:
  - @stll/ui@0.62.0

## 0.15.3

### Patch Changes

- Updated dependencies [[`a2ff7a7`](https://github.com/stella/stella/commit/a2ff7a75f1f1f0d1cc9e64517449fe2462a2e636)]:
  - @stll/ui@0.61.0

## 0.15.2

### Patch Changes

- Updated dependencies [[`a8532a0`](https://github.com/stella/stella/commit/a8532a054628dc979e3bc7e48d807cb44e2d66b2), [`496eff7`](https://github.com/stella/stella/commit/496eff74a703471be2b2075d24c2e78159e2bc57), [`ac06603`](https://github.com/stella/stella/commit/ac06603f5b187b45bc1ca741cf9d2496959eab5a), [`92038d5`](https://github.com/stella/stella/commit/92038d59d484f5f59e36fa35e297cc19bf3e6e2c), [`8f35c0f`](https://github.com/stella/stella/commit/8f35c0f990c12833a18adf4cdb86a69b3681acdc), [`8f35c0f`](https://github.com/stella/stella/commit/8f35c0f990c12833a18adf4cdb86a69b3681acdc)]:
  - @stll/ui@0.60.0

## 0.15.1

### Patch Changes

- Updated dependencies [[`9921a8c`](https://github.com/stella/stella/commit/9921a8c5bd913959aedeb011652319b3da45e4aa), [`92f36ca`](https://github.com/stella/stella/commit/92f36ca0d250a034df4624bab82b173618020099)]:
  - @stll/ui@0.59.0

## 0.15.0

### Minor Changes

- [#7347](https://github.com/stella/stella/pull/7347) [`d75e2c0`](https://github.com/stella/stella/commit/d75e2c0cca2ee7a0e9411a2a8754a046110cdad7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add nonfocusable context-menu anchors and full-name disclosure for clipped identity text. Preserve nested sidebar action boundaries and give sort controls a dedicated accessible label contract.

### Patch Changes

- Updated dependencies [[`ed2a1a6`](https://github.com/stella/stella/commit/ed2a1a6c7d277f9c87034b3dd35b67042da9df05), [`d75e2c0`](https://github.com/stella/stella/commit/d75e2c0cca2ee7a0e9411a2a8754a046110cdad7), [`e2e9d3d`](https://github.com/stella/stella/commit/e2e9d3d9718707b190c09db77c63f1c9ee9136a8)]:
  - @stll/ui@0.58.0

## 0.14.4

### Patch Changes

- Updated dependencies [[`414be5f`](https://github.com/stella/stella/commit/414be5f89e3e8e8b8c2b53cc91e8417329418f4f)]:
  - @stll/ui@0.57.0

## 0.14.3

### Patch Changes

- Updated dependencies [[`5f8488b`](https://github.com/stella/stella/commit/5f8488bae2460f50d2be4f5023849d65bdb27f1e), [`5cd5fc7`](https://github.com/stella/stella/commit/5cd5fc79a4bd906e988f470b2ce47dd94f52e103), [`cd9dee0`](https://github.com/stella/stella/commit/cd9dee042a40d9994f2a1bc909631f67b161935d), [`ac83ccd`](https://github.com/stella/stella/commit/ac83ccdf2a88f07a256c125556577059e39a93a5), [`58dfdd9`](https://github.com/stella/stella/commit/58dfdd95556ac4cd2a8b4ea8fb7255f465077564), [`d40c675`](https://github.com/stella/stella/commit/d40c675550c00678dd3763c2a0a6faf953276377), [`43aa0c5`](https://github.com/stella/stella/commit/43aa0c584bf62fc2805627eb6ae8dfb39395051d), [`de3dbc9`](https://github.com/stella/stella/commit/de3dbc9c40e2cd37da7a2fe7251009ad64340f20)]:
  - @stll/ui@0.56.0

## 0.14.2

### Patch Changes

- Updated dependencies [[`9c0ea0e`](https://github.com/stella/stella/commit/9c0ea0e95c1e9f9edc9ffaa84cb18e4c43a85d8b), [`df53905`](https://github.com/stella/stella/commit/df5390529e1e6bc783d2e442b57bb959ad8acadd), [`b1db339`](https://github.com/stella/stella/commit/b1db33914f1bd2cb04d1760ffd8ff1a222c806c2), [`5e31c64`](https://github.com/stella/stella/commit/5e31c6433b4bf3400ebb7d137d137e81e419b236), [`cd78348`](https://github.com/stella/stella/commit/cd7834897fba75056fa30f8351ccc42dd46a16a0)]:
  - @stll/ui@0.55.0

## 0.14.1

### Patch Changes

- Updated dependencies [[`276fe8f`](https://github.com/stella/stella/commit/276fe8f46a263509a6e864505a9bdd75ffa75f56), [`dd1480b`](https://github.com/stella/stella/commit/dd1480bd335acd79fe88484b69416410c215786c), [`051ed71`](https://github.com/stella/stella/commit/051ed716e83bcc8d822317735bef0b06cd7cd6a0), [`85a8893`](https://github.com/stella/stella/commit/85a88937362ad495f74f167b557250608862b77d), [`58b429b`](https://github.com/stella/stella/commit/58b429b124f1a5ff110e20b31a0f8fc6143c8e65), [`106c7d6`](https://github.com/stella/stella/commit/106c7d6e21e240156f8d98305315cb5fe1ed1a84), [`0d610b6`](https://github.com/stella/stella/commit/0d610b62b0101f921a36b37439a0406a40db8797)]:
  - @stll/ui@0.54.0

## 0.14.0

### Minor Changes

- [#7018](https://github.com/stella/stella/pull/7018) [`16d1f58`](https://github.com/stella/stella/commit/16d1f58e9f0670401d13294d3199afedd92a4b9d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Sort chips name their direction with the caller's wording for the property's sort kind. `SortableProperty` takes a required `sortKind` and `SortChipsLabels` a total `directions` record, both typed by the new `@stll/workspace-ui/column-sort` entry (`ColumnSortKind`, `SortDirection`, `SortDirectionLabels`). `sortDirectionHint` and its hard-coded `A→Z` / `1→9` / arrow hints are removed.

- [#6956](https://github.com/stella/stella/pull/6956) [`650aa33`](https://github.com/stella/stella/commit/650aa3349fafcc7b0c69fc9e9375ed4eb52a369b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `@stll/workspace-ui/formatting` with `WorkspaceUiFormattingProvider`. Field values and column calculations format numbers, money and dates in the locale it supplies instead of `use-intl`'s locale, so a host can keep the UI language and the regional format apart. Rendering them outside the provider throws.

## 0.13.2

### Patch Changes

- Updated dependencies [[`48c0025`](https://github.com/stella/stella/commit/48c002525572684e4c8e96ad50eec065313295b0), [`e4836e1`](https://github.com/stella/stella/commit/e4836e18472a659a03e9e7d80156685739ce3aed), [`4dde81d`](https://github.com/stella/stella/commit/4dde81dd999d620a00b9000f0d8431b9e4d5ae98), [`c89ddbb`](https://github.com/stella/stella/commit/c89ddbb42c973e447f05dcf0f30c124b7462824b), [`7746519`](https://github.com/stella/stella/commit/774651920e9c2c16bdb352a117b2a51f21e35cc5), [`b942114`](https://github.com/stella/stella/commit/b9421146019be23569fb7f3cba3b8f094422d7a3)]:
  - @stll/ui@0.53.0

## 0.13.1

### Patch Changes

- [#6790](https://github.com/stella/stella/pull/6790) [`85c80dd`](https://github.com/stella/stella/commit/85c80dd20e5d55b981c60f58786fe18c88d1058f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `ResponsiveActionToolbar` wraps its slots instead of scrolling them behind a hidden scrollbar, and the action slot aligns to the inline end by itself.
- Updated dependencies [[`4fe45ad`](https://github.com/stella/stella/commit/4fe45ad8fc654bb759207c22008d38bc15344091)]:
  - @stll/ui@0.52.0

## 0.13.0

### Minor Changes

- [#6268](https://github.com/stella/stella/pull/6268) [`5fb50f0`](https://github.com/stella/stella/commit/5fb50f0fe6c2161d41c50a46cb961aaa8f037494) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow hosts to provide typed content for workspace feature previews while retaining the default scenes.

- [#6247](https://github.com/stella/stella/pull/6247) [`d2ad946`](https://github.com/stella/stella/commit/d2ad946f78aa870f47a2f3e7cddf4028e7481c0c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `@stll/workspace-ui/feature-previews`: static product scenes (matters, documents, research, billing, contacts, time tracking) composed from the app's own components, for marketing pages, menus and slides. Each scene takes its interface labels and a formatting locale. Add `@stll/workspace-ui/task-status`, the glyph and colour of each task status.

### Patch Changes

- [#6472](https://github.com/stella/stella/pull/6472) [`83e4634`](https://github.com/stella/stella/commit/83e4634ae41525365ddcca368db1d128e6448729) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Paginate filesystem tree reads and expose bounded text previews in entity lists.
- Updated dependencies [[`7835dfd`](https://github.com/stella/stella/commit/7835dfd514ad56fce2a4f00fd4bf0bd522188d34), [`281665b`](https://github.com/stella/stella/commit/281665baa193e2ab2b3acba0da3a259ec16a770a), [`a765cda`](https://github.com/stella/stella/commit/a765cdaeb5718de31b707958364dfde7b6c98594), [`2dd1699`](https://github.com/stella/stella/commit/2dd16994dfba74f35540d47b1582e428ba7b4bc1), [`85a56db`](https://github.com/stella/stella/commit/85a56dbbf73156b5b7e4a0e37c73db382aa02ada)]:
  - @stll/ui@0.51.0

## 0.12.7

### Patch Changes

- Updated dependencies [[`ab74b25`](https://github.com/stella/stella/commit/ab74b2560766d05d67c302c4b81639351ef33a64), [`8cb7fd4`](https://github.com/stella/stella/commit/8cb7fd43886be0ef8dc9be107eafac32613d504a), [`ae6605a`](https://github.com/stella/stella/commit/ae6605a93f22d05aab53205059032237f0e1cbd8), [`c48136a`](https://github.com/stella/stella/commit/c48136ad775ad38e1e7f4a9ca91caa485e827952)]:
  - @stll/ui@0.50.0

## 0.12.6

### Patch Changes

- Updated dependencies [[`6787bf4`](https://github.com/stella/stella/commit/6787bf4a6e33a5fa97538d91428d928ffffaabc8), [`f68baf7`](https://github.com/stella/stella/commit/f68baf7f2240db328e62201120dde71f3baf2b7b)]:
  - @stll/ui@0.49.0

## 0.12.5

### Patch Changes

- Updated dependencies [[`ed25af1`](https://github.com/stella/stella/commit/ed25af1211e6e5f091842ddf553f2795f5c16622)]:
  - @stll/ui@0.48.0

## 0.12.4

### Patch Changes

- [#5740](https://github.com/stella/stella/pull/5740) [`39eac6e`](https://github.com/stella/stella/commit/39eac6e360d0e4bbe23f61c6970ade7852f3927d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A destructive confirm dialog stays open when its confirm settles to `"keep-open"`, and a host-responsive workspace frame may omit its end dock.
- Updated dependencies [[`39eac6e`](https://github.com/stella/stella/commit/39eac6e360d0e4bbe23f61c6970ade7852f3927d)]:
  - @stll/ui@0.47.1

## 0.12.3

### Patch Changes

- Updated dependencies [[`55d62c9`](https://github.com/stella/stella/commit/55d62c989b81bf063cc4cef899aae4a3efe00077)]:
  - @stll/ui@0.47.0

## 0.12.2

### Patch Changes

- [#5858](https://github.com/stella/stella/pull/5858) [`a67d306`](https://github.com/stella/stella/commit/a67d306deebd7e5d6bdec53e907996990dcee819) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update runtime dependencies.

- [#5646](https://github.com/stella/stella/pull/5646) [`4479e67`](https://github.com/stella/stella/commit/4479e67c3290234e3a73fc307b213eb061f74870) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Pad edge-attached surfaces (workspace shell, rails, sheets, bottom-stuck dialogs, toasts) with the device safe-area insets, contain overscroll in shared scrollers, keep long-press from selecting control labels, use a strong ease-out for entering and exiting motion, and give `Button` a short press scale while it is enabled.
- Updated dependencies [[`eac3ba7`](https://github.com/stella/stella/commit/eac3ba744bf28f96adcec06a6ebc9edf6b60d1c1), [`4a9c808`](https://github.com/stella/stella/commit/4a9c808a3c3d68cfcc53496913c3a531c8bcfe94), [`4479e67`](https://github.com/stella/stella/commit/4479e67c3290234e3a73fc307b213eb061f74870), [`1b7773e`](https://github.com/stella/stella/commit/1b7773effd472e11422bc82d0d417fdf22ce9ff1), [`ad3cd0a`](https://github.com/stella/stella/commit/ad3cd0a68ebcb2bee63dc8a8d12a0fb3c9783975)]:
  - @stll/ui@0.46.0

## 0.12.1

### Patch Changes

- [#5693](https://github.com/stella/stella/pull/5693) [`fec0951`](https://github.com/stella/stella/commit/fec0951abe78c4e626739c8323267b12d0a8e5cf) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update runtime dependencies.
- Updated dependencies [[`9da3cbb`](https://github.com/stella/stella/commit/9da3cbb84db47b67b93fcd3b6f327ba3eb739baf), [`c7f973a`](https://github.com/stella/stella/commit/c7f973adced14ab6250f4a0edfa553303998bc27), [`3000990`](https://github.com/stella/stella/commit/3000990a7130ed52723e5fb1b4ece25bf5f42427), [`15e1b82`](https://github.com/stella/stella/commit/15e1b82218dd6447eaba4df106f7d3585e9b6775), [`a8c77be`](https://github.com/stella/stella/commit/a8c77be4ed683ad5d91d843220ddd1eb51486370), [`ebfe05e`](https://github.com/stella/stella/commit/ebfe05e6b528df99966f4a8e3ac1bec9be1eb778), [`4e86d4d`](https://github.com/stella/stella/commit/4e86d4deb48c5f0d9a2bcb6e454afdd34e78a788), [`70a05b2`](https://github.com/stella/stella/commit/70a05b2dabd5bc7bb2422b2d0ae21e1c718c6974), [`fb4de95`](https://github.com/stella/stella/commit/fb4de9573ae022e1c006c81fff9022aa97e45ec1), [`0c55af7`](https://github.com/stella/stella/commit/0c55af71de6f04e11217bad1706b149736a8639b), [`f01d3ab`](https://github.com/stella/stella/commit/f01d3ab91b22613acfd563e5df9ffa6129b19bd5)]:
  - @stll/ui@0.45.0

## 0.12.0

### Minor Changes

- [#5318](https://github.com/stella/stella/pull/5318) [`f5e1e2b`](https://github.com/stella/stella/commit/f5e1e2bf6a143f0556647d5ac6f5a5f71c1f931a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `@stll/ui/inline-reorder` and `@stll/ui/inline-drop-indicator` for reordering a horizontal row of items by closest edge. `@stll/workspace-ui` now uses them for view tabs and no longer exports `reorderWorkspaceViewIds`, `toWorkspaceViewDropPosition` or the `./view-switcher-logic` entry point.

- [#5175](https://github.com/stella/stella/pull/5175) [`84d35ae`](https://github.com/stella/stella/commit/84d35ae3c652403524ea11ebba22e40d8949c929) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use updated Pragmatic drag and drop dependencies and public entry points.

### Patch Changes

- Updated dependencies [[`2718337`](https://github.com/stella/stella/commit/2718337304469b3c4e0d0304a15b9864c70a2aa9), [`f5e1e2b`](https://github.com/stella/stella/commit/f5e1e2bf6a143f0556647d5ac6f5a5f71c1f931a), [`84d35ae`](https://github.com/stella/stella/commit/84d35ae3c652403524ea11ebba22e40d8949c929)]:
  - @stll/ui@0.44.0

## 0.11.23

### Patch Changes

- Updated dependencies [[`83b4487`](https://github.com/stella/stella/commit/83b44876fe05b865329a622176ee8fd8fc51a4d8), [`e571295`](https://github.com/stella/stella/commit/e57129541729f01b92c5c64fbb2e3451507a4e7a), [`684f296`](https://github.com/stella/stella/commit/684f2963fdfab360198780bfcc0b188c5692b913), [`bf6a6a3`](https://github.com/stella/stella/commit/bf6a6a3e2f27df61169ddaabf85d3392dde5d222), [`598f3c4`](https://github.com/stella/stella/commit/598f3c44be0666ebca901a214e4fbf5bed547d3d), [`7bb8e47`](https://github.com/stella/stella/commit/7bb8e47bc85fad689ff939399eb5f553e65b1f54), [`b982f7f`](https://github.com/stella/stella/commit/b982f7fbbc86741e6d9df68a7da46bfaa5be669e)]:
  - @stll/ui@0.43.0

## 0.11.22

### Patch Changes

- [#4828](https://github.com/stella/stella/pull/4828) [`d754a5f`](https://github.com/stella/stella/commit/d754a5f7c59be5e05b47f09699706d2dcb55675c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update compatible runtime dependency versions.
- Updated dependencies [[`e3c7e1c`](https://github.com/stella/stella/commit/e3c7e1c53cd393918a75af4c8a0a9e559908814e)]:
  - @stll/ui@0.42.1

## 0.11.21

### Patch Changes

- Updated dependencies [[`b8a1d41`](https://github.com/stella/stella/commit/b8a1d41da558c4c148fd696a714d56621ecb2db3)]:
  - @stll/money@0.3.0
  - @stll/calculations@0.1.2

## 0.11.20

### Patch Changes

- Updated dependencies [[`019d735`](https://github.com/stella/stella/commit/019d735308d3baec6d4143c61b3b5a5e38fe8ce9)]:
  - @stll/ui@0.42.0

## 0.11.19

### Patch Changes

- Updated dependencies [[`9669e8a`](https://github.com/stella/stella/commit/9669e8acbb6460e3fbf32478eb0dd2c0a0c1c185)]:
  - @stll/ui@0.41.0

## 0.11.18

### Patch Changes

- [#4505](https://github.com/stella/stella/pull/4505) [`20902c2`](https://github.com/stella/stella/commit/20902c2f6c7adc4899504538e2ce701b51eb08e5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Declare React type packages as optional peers so isolated and global-store installs resolve React types.
- Updated dependencies [[`7511562`](https://github.com/stella/stella/commit/75115627f781b29b63f3dc7cd92ae82506a89367), [`20902c2`](https://github.com/stella/stella/commit/20902c2f6c7adc4899504538e2ce701b51eb08e5)]:
  - @stll/ui@0.40.2

## 0.11.17

### Patch Changes

- Updated dependencies [[`96a31ab`](https://github.com/stella/stella/commit/96a31abbb7f6ddae0aa4c1ea857559b714190ff1)]:
  - @stll/ui@0.40.0

## 0.11.16

### Patch Changes

- Updated dependencies [[`8c81796`](https://github.com/stella/stella/commit/8c81796e512762094793acc16eb13f3e49c7cc61), [`deb3ce4`](https://github.com/stella/stella/commit/deb3ce49c36f89c6371731d6706e777ad8fbed3b)]:
  - @stll/ui@0.39.0

## 0.11.15

### Patch Changes

- Updated dependencies [[`3f1bdaf`](https://github.com/stella/stella/commit/3f1bdafb817d599f49d21c5d853ea76720278236), [`f215762`](https://github.com/stella/stella/commit/f2157623605b1a08efbed05866773da8b8618d93)]:
  - @stll/ui@0.38.0

## 0.11.14

### Patch Changes

- [#4203](https://github.com/stella/stella/pull/4203) [`a78e2c4`](https://github.com/stella/stella/commit/a78e2c4172bfb9b61d120cb635248dc70e4f0178) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove unused dependency declarations.

## 0.11.13

### Patch Changes

- [#4067](https://github.com/stella/stella/pull/4067) [`8b243c4`](https://github.com/stella/stella/commit/8b243c4aadc1b002c6b5978046f2991b7eaa4de2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `@stll/ui/icons`, one module for every icon, with semantic entries such as `SkillIcon` and `AiActionIcon`. `@stll/chat` and `@stll/workspace-ui` import their icons from it.
- Updated dependencies [[`8b243c4`](https://github.com/stella/stella/commit/8b243c4aadc1b002c6b5978046f2991b7eaa4de2)]:
  - @stll/ui@0.37.0

## 0.11.12

### Patch Changes

- Updated dependencies [[`0dcdbf1`](https://github.com/stella/stella/commit/0dcdbf12af4bfcd80dfc9d3863258455580ad612)]:
  - @stll/ui@0.36.0

## 0.11.11

### Patch Changes

- Updated dependencies [[`9d57661`](https://github.com/stella/stella/commit/9d576613d04dd842c18c3074baf7c9f30927deeb)]:
  - @stll/ui@0.35.0

## 0.11.10

### Patch Changes

- [#3744](https://github.com/stella/stella/pull/3744) [`de044f5`](https://github.com/stella/stella/commit/de044f5f0c926a7b7b722fd588e24c845a48c64d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the inspector layout tokens as `@stll/ui/layout-tokens`, and export the shared field-value parts (`formatIntFieldValue`, `PersonAvatar`, `PendingSkeleton`, the empty, error, unsupported and clip renderers, and the select and int styling helpers) from `@stll/workspace-ui/field-value`.
- Updated dependencies [[`de044f5`](https://github.com/stella/stella/commit/de044f5f0c926a7b7b722fd588e24c845a48c64d), [`baf3942`](https://github.com/stella/stella/commit/baf3942ca885c16b7b9542f3cc2fb8b1e8a15f84), [`6b7dcc2`](https://github.com/stella/stella/commit/6b7dcc2aa330b863c8638497f5e463aa776480f4)]:
  - @stll/ui@0.34.4

## 0.11.9

### Patch Changes

- [#3728](https://github.com/stella/stella/pull/3728) [`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow optional values before they reach rendered text and messages. The outline rail no longer draws a tick for a heading whose id matches an object prototype key.
- Updated dependencies [[`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1)]:
  - @stll/money@0.2.1
  - @stll/ui@0.34.3

## 0.11.8

### Patch Changes

- [#3633](https://github.com/stella/stella/pull/3633) [`e5e9466`](https://github.com/stella/stella/commit/e5e946637a54cf09eba1beb4c4a5cc3f0bbb2e06) Thanks [@dependabot](https://github.com/apps/dependabot)! - Require `@atlaskit/pragmatic-drag-and-drop-hitbox` 2.2.2 or newer and use its
  supported `Edge` type entry point.

## 0.11.7

### Patch Changes

- [#3593](https://github.com/stella/stella/pull/3593) [`2c53e9f`](https://github.com/stella/stella/commit/2c53e9fba0b5607f3d90c0c4456db5d0ee5a5d21) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose stable semantic metadata for selectable inspector, toolbar, and workspace-view controls.
- Updated dependencies [[`528c647`](https://github.com/stella/stella/commit/528c647d8822c7b701e6ecb4f5ed637cd83f48ff), [`49b0423`](https://github.com/stella/stella/commit/49b04238ec5fd6e369b037edd732f56e0d12de62), [`2c53e9f`](https://github.com/stella/stella/commit/2c53e9fba0b5607f3d90c0c4456db5d0ee5a5d21)]:
  - @stll/ui@0.34.0

## 0.11.6

### Patch Changes

- Updated dependencies [[`7b059b3`](https://github.com/stella/stella/commit/7b059b3856829ee676a73125d766c8b9c15f71fb)]:
  - @stll/ui@0.33.0

## 0.11.5

### Patch Changes

- Updated dependencies [[`123956f`](https://github.com/stella/stella/commit/123956f16ae7504a8a523c2831a59d9b55ca750e)]:
  - @stll/ui@0.32.0

## 0.11.4

### Patch Changes

- Updated dependencies [[`708194f`](https://github.com/stella/stella/commit/708194f5132bb512d9aae6441d3cdb52bf984a08)]:
  - @stll/ui@0.31.0

## 0.11.3

### Patch Changes

- Updated dependencies [[`b983020`](https://github.com/stella/stella/commit/b983020612e73f9039b869c629c9a2dd412f17cd)]:
  - @stll/ui@0.30.0

## 0.11.2

### Patch Changes

- [#3502](https://github.com/stella/stella/pull/3502) [`7a78745`](https://github.com/stella/stella/commit/7a787456cbadc8c017e17a1f38e18c770967a590) Thanks [@voidstackloop](https://github.com/voidstackloop)! - Keep the new-view action visible and separated from overflowing workspace tabs.

## 0.11.1

### Patch Changes

- [#3453](https://github.com/stella/stella/pull/3453) [`15b8cb3`](https://github.com/stella/stella/commit/15b8cb3b3ea8acbf7a99dca23751709aed7c852e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `PopoverPopup` takes a `padding` prop (`none`, `xs`, `sm`, `md`, `default`) for its viewport instead of callers reaching into the `popover-viewport` slot. `SelectTrigger size="sm"` and `Button size="sm"` render small text themselves. Theme tokens `shadow-floating` and `shadow-floating-ring` replace inline shadow recipes.
- Updated dependencies [[`15b8cb3`](https://github.com/stella/stella/commit/15b8cb3b3ea8acbf7a99dca23751709aed7c852e), [`15b8cb3`](https://github.com/stella/stella/commit/15b8cb3b3ea8acbf7a99dca23751709aed7c852e)]:
  - @stll/ui@0.29.0

## 0.11.0

### Minor Changes

- [#3435](https://github.com/stella/stella/pull/3435) [`79b2d6f`](https://github.com/stella/stella/commit/79b2d6f8aa38df700555a2cdaa796af36c536433) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add agenda-kind filters and shared view-toolbar and Kanban proposal primitives. Expose cross-matter saved-view operations through the generated CLI capability tree. Replace view-switcher `renderActions` with `actionMenu`, which owns the vertical menu trigger. Hide redundant empty-lane counts and let empty Kanban cells scroll with the board.

### Patch Changes

- Updated dependencies [[`79b2d6f`](https://github.com/stella/stella/commit/79b2d6f8aa38df700555a2cdaa796af36c536433)]:
  - @stll/conditions@0.4.0
  - @stll/ui@0.28.0

## 0.10.5

### Patch Changes

- Updated dependencies [[`c39769f`](https://github.com/stella/stella/commit/c39769fb528e2b195b127bf64a7f9c42520747b8)]:
  - @stll/ui@0.27.0

## 0.10.4

### Patch Changes

- [#3307](https://github.com/stella/stella/pull/3307) [`a51b7f1`](https://github.com/stella/stella/commit/a51b7f1cdc8d52ec774ce5c96279f9391a204f0b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Align matter view controls with the bottom-edge active indicator.

## 0.10.3

### Patch Changes

- [#3279](https://github.com/stella/stella/pull/3279) [`e9d51b4`](https://github.com/stella/stella/commit/e9d51b4a88c55eebfb441614372b1e0edcde5b06) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A pending field value shows a skeleton shaped to its kind instead of a spinner.
- Updated dependencies [[`7da4d12`](https://github.com/stella/stella/commit/7da4d12d1e4b5b518fb9d28ee12c28fb5b47eecc)]:
  - @stll/ui@0.26.4

## 0.10.2

### Patch Changes

- [#3141](https://github.com/stella/stella/pull/3141) [`088e15d`](https://github.com/stella/stella/commit/088e15d2cb4c37a1b7f7e5380bbca62ab1704ce2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Temporal for calendar calculations and wall clocks, with a native implementation when available and a bundled fallback otherwise. Preserve serialized timestamps and existing Date-based library interfaces.
- Updated dependencies [[`088e15d`](https://github.com/stella/stella/commit/088e15d2cb4c37a1b7f7e5380bbca62ab1704ce2)]:
  - @stll/ui@0.26.1

## 0.10.1

### Patch Changes

- Updated dependencies [[`8668780`](https://github.com/stella/stella/commit/8668780fbc7ba60ecf40806c79d2b5f6ef1a6b87)]:
  - @stll/ui@0.26.0

## 0.10.0

### Minor Changes

- [#2967](https://github.com/stella/stella/pull/2967) [`5d79253`](https://github.com/stella/stella/commit/5d79253451d8227af942bf0c4883548977531490) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Converting between major and minor units asks the currency.
  `toMinorUnits({ amount, currency })` and `toMajorUnits({ amountCents, currency })` scale by the
  currency's own exponent (100 for USD, 1 for JPY, 1000 for KWD), and
  `formatMoneyCents` takes an optional `fractionDigits` for a rounded summary.

  `toMinorUnits` accepts the decimal TEXT a form holds as well as a number, and
  scales it by moving digits rather than multiplying a float: `1.005` in USD is
  101, where `1.005 * 100` is 100.49999999999999 and rounds to 100. It panics on
  an amount it cannot store; `tryToMinorUnits` returns null instead, for callers
  holding text nobody has vouched for yet.

  BREAKING: `cents()` now rejects an integer outside the safe range, where
  `x + 1 === x` and a running total silently stops moving. `@stll/workspace-ui` no
  longer re-exports `currencyMinorUnitDigits`, `formatMoneyCents`, or
  `FormatMoneyCentsParams`; import them from `@stll/money`.

### Patch Changes

- [#2939](https://github.com/stella/stella/pull/2939) [`b36e13f`](https://github.com/stella/stella/commit/b36e13ff49aef6d4fbfd2f476fbad4f3307e975e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Align workspace view tabs with their toolbar and keep action space stable while switching views. Use the subtle scrollbar treatment for inspector content and rail scrolling.

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.
- Updated dependencies [[`b36e13f`](https://github.com/stella/stella/commit/b36e13ff49aef6d4fbfd2f476fbad4f3307e975e), [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3), [`dd9e048`](https://github.com/stella/stella/commit/dd9e0482f49ef8bda3a19e6a14f26595d5dd7c83), [`2ad98a4`](https://github.com/stella/stella/commit/2ad98a402e65877a433eb5061a05f4338b807b38), [`5d79253`](https://github.com/stella/stella/commit/5d79253451d8227af942bf0c4883548977531490)]:
  - @stll/ui@0.25.1
  - @stll/calculations@0.1.1
  - @stll/conditions@0.3.1
  - @stll/money@0.2.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`56d9efa`](https://github.com/stella/stella/commit/56d9efa4e9c7a958ec2163b3336de494d14ae89e), [`1623392`](https://github.com/stella/stella/commit/1623392d12744ae00bea7f585bed27074dfc9416)]:
  - @stll/ui@0.25.0

## 0.9.0

### Minor Changes

- [#2918](https://github.com/stella/stella/pull/2918) [`abe4ff7`](https://github.com/stella/stella/commit/abe4ff770b4efcf1d193e960e5b4d5575bfc11fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A workspace frame that describes neither an end rail nor an inspector now mounts no end dock at all, so its content area runs to the inline-end edge instead of reserving an empty 48px rail.

### Patch Changes

- Updated dependencies [[`45b6897`](https://github.com/stella/stella/commit/45b68970d4973ec35676b6c3b4e7ed5e41ff48d7), [`abe4ff7`](https://github.com/stella/stella/commit/abe4ff770b4efcf1d193e960e5b4d5575bfc11fe)]:
  - @stll/ui@0.24.0

## 0.8.3

### Patch Changes

- Updated dependencies [[`35dbb71`](https://github.com/stella/stella/commit/35dbb7146e3214fc99be568c5aa0b06bb8149e2a), [`ad8ee17`](https://github.com/stella/stella/commit/ad8ee1726c7246487733c3c54653efef49e4573c)]:
  - @stll/ui@0.23.0

## 0.8.2

### Patch Changes

- Updated dependencies [[`a7ffd5e`](https://github.com/stella/stella/commit/a7ffd5eadeb4f09e859bb9d0daf95a2ad7bc1a01), [`f38684c`](https://github.com/stella/stella/commit/f38684c842ac1dd7dca0897a3afa56c80c202e48)]:
  - @stll/ui@0.22.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`c15d115`](https://github.com/stella/stella/commit/c15d1159d9f211d5ac6ce460b3254d927a9f1bc1)]:
  - @stll/ui@0.21.0

## 0.8.0

### Minor Changes

- [#2854](https://github.com/stella/stella/pull/2854) [`47d3d57`](https://github.com/stella/stella/commit/47d3d5741d51d8b4e70f34cd7ab4535deb12fd0d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `WorkspaceFrame`'s described composition can now render its navigation through the sidebar shell from `@stll/ui/sidebar`. Pass `navigation.sidebar` to get the same collapsible sidebar Stella's own app uses: a header row at toolbar height with a brand slot and a collapse toggle, the described items as sidebar menu buttons with labels while expanded and tooltips while collapsed, and the footer slot below. `open`, `onOpenChange`, `defaultOpen`, and `forceCollapsed` pass through to the sidebar provider so the host owns persistence. Without `navigation.sidebar`, the frame renders the application rail exactly as before.

  `WorkspaceViewSwitcher`'s strip is now one toolbar row (`TOOLBAR_ROW_HEIGHT`), the same height as the frame's top bar and a kanban column header, instead of taking its height from the tabs inside it.

  `SidebarMenuButton` gains `size="rail"`: a 44px target while expanded and while collapsed to the icon rail, for a sidebar that stands in for the application rail.

  `@stll/ui/sidebar` types the custom properties it sets on a local style type instead of a package-private module augmentation, so a consumer compiling the module from source no longer fails on `--sidebar-width`.

### Patch Changes

- [#2845](https://github.com/stella/stella/pull/2845) [`9dd7ff4`](https://github.com/stella/stella/commit/9dd7ff4554ffafc615f5495fd340619576c7a589) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Document that `WorkspaceFrame`'s `host-responsive` composition is where a host mounts an expandable/collapsible sidebar (such as the shell now published at `@stll/ui/sidebar`), while `described` always renders the narrower, fixed-width `ApplicationRail`.
- Updated dependencies [[`d5170f5`](https://github.com/stella/stella/commit/d5170f5ea212deee686d5d8d6bfa0a431e2657d6), [`1943eed`](https://github.com/stella/stella/commit/1943eed7b652379b67522905518f06b4cd771e36), [`9dd7ff4`](https://github.com/stella/stella/commit/9dd7ff4554ffafc615f5495fd340619576c7a589), [`47d3d57`](https://github.com/stella/stella/commit/47d3d5741d51d8b4e70f34cd7ab4535deb12fd0d)]:
  - @stll/ui@0.20.0

## 0.7.2

### Patch Changes

- Updated dependencies [[`df70e4e`](https://github.com/stella/stella/commit/df70e4ee1031c6488686ffe82594e3cb026c5193), [`b08e83e`](https://github.com/stella/stella/commit/b08e83e935a5078f2b5a771a72c5a8c13750e3d9), [`d751a9c`](https://github.com/stella/stella/commit/d751a9c92ae4f3a6d746b4141e4fe178d49bbfca)]:
  - @stll/ui@0.19.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`45b076c`](https://github.com/stella/stella/commit/45b076ca5ea2c97b1534e7ee2493b0272064194b), [`67baa75`](https://github.com/stella/stella/commit/67baa75ca462fdb72ef9709e7dd3c7752a03411f), [`af89254`](https://github.com/stella/stella/commit/af89254e3173eec3551f027f12fe1490624670b5), [`6fb442a`](https://github.com/stella/stella/commit/6fb442ad7da2a21f7540e06029086bd04ee559a8)]:
  - @stll/conditions@0.3.0
  - @stll/ui@0.18.0

## 0.7.0

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

### Patch Changes

- Updated dependencies [[`6e437b5`](https://github.com/stella/stella/commit/6e437b5eca2beba037c380a8a7475055df41c0f3)]:
  - @stll/ui@0.17.0

## 0.6.3

### Patch Changes

- [#2706](https://github.com/stella/stella/pull/2706) [`6dd0e90`](https://github.com/stella/stella/commit/6dd0e90c14e0fc39d15783c78a605b61f1e8a8ba) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update TanStack Table to 9.2.3, preserving filter metadata and parent-first flattened rows for hierarchical tables.
- Updated dependencies [[`0aeaa0f`](https://github.com/stella/stella/commit/0aeaa0f1fab5c562d153dce4338e2c039afb86b6)]:
  - @stll/ui@0.16.1

## 0.6.2

### Patch Changes

- Updated dependencies [[`baa8677`](https://github.com/stella/stella/commit/baa86771abbe8e7f50d1ced611a434328a478b3c), [`0e93dee`](https://github.com/stella/stella/commit/0e93deec1bcf1284fe6b61fe24dde916ee53b29d)]:
  - @stll/ui@0.16.0

## 0.6.1

### Patch Changes

- [#2753](https://github.com/stella/stella/pull/2753) [`b709089`](https://github.com/stella/stella/commit/b7090892e514550b1599b344823f63ca0854bb06) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render one responsive inspector presentation at a time in the complete workspace frame.
- Updated dependencies [[`23c39cf`](https://github.com/stella/stella/commit/23c39cf74812da26020e97b7c9a9ce12259ea707), [`0751826`](https://github.com/stella/stella/commit/0751826516062111ad9491b95aaad9ee86878a36)]:
  - @stll/ui@0.15.0

## 0.6.0

### Minor Changes

- [#2733](https://github.com/stella/stella/pull/2733) [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a descriptor-driven workspace frame that owns application navigation and inspector chrome.

### Patch Changes

- Updated dependencies [[`81da3b3`](https://github.com/stella/stella/commit/81da3b39ec8044e9398ee4c01f7bbbdd9a36de36), [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0)]:
  - @stll/ui@0.14.0

## 0.5.2

### Patch Changes

- [#2718](https://github.com/stella/stella/pull/2718) [`3ba47d9`](https://github.com/stella/stella/commit/3ba47d972edf440db68e290d0d1f30c7ab66e8f7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hide native scrollbar chrome while retaining horizontal overflow in responsive action toolbars.

- [#2717](https://github.com/stella/stella/pull/2717) [`ee35cfa`](https://github.com/stella/stella/commit/ee35cfa57dac2a87187f9451f53e5d40b2aaf683) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep actions attached to a workspace view tab aligned with its label.

## 0.5.1

### Patch Changes

- Updated dependencies [[`5a4fa91`](https://github.com/stella/stella/commit/5a4fa911178e25717079e00d048d3a38daf50e7b)]:
  - @stll/ui@0.13.0

## 0.5.0

### Minor Changes

- [#2668](https://github.com/stella/stella/pull/2668) [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the responsive action toolbar for compact workspace controls and allow
  single-purpose shells to omit a compact navigation trigger.

### Patch Changes

- Updated dependencies [[`fb97db5`](https://github.com/stella/stella/commit/fb97db59eb4756fd6b0bd82ce42c3016d6946d66), [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929)]:
  - @stll/ui@0.12.1

## 0.4.4

### Patch Changes

- Updated dependencies [[`58c51a3`](https://github.com/stella/stella/commit/58c51a3018ca64ed898e1598b1daba6fe7a71bc8), [`88bf7fb`](https://github.com/stella/stella/commit/88bf7fb898ece322c3b7d2aa015dcb7b5d1da8a8), [`00bd34d`](https://github.com/stella/stella/commit/00bd34d7b6d4204749730813ae2cde4a2e82047e), [`0b7892b`](https://github.com/stella/stella/commit/0b7892bd9b3b440db2da3604ca05c806d458e98f)]:
  - @stll/ui@0.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [[`c56a0c7`](https://github.com/stella/stella/commit/c56a0c7e97ef276b1353a7621e4658b2d9f2ada0)]:
  - @stll/ui@0.11.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`37b6437`](https://github.com/stella/stella/commit/37b64377f9806be3da0a9cf9b33e7b984e46ed1a)]:
  - @stll/ui@0.10.0

## 0.4.1

### Patch Changes

- [#2561](https://github.com/stella/stella/pull/2561) [`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve a board's group identifier union through grouping, saved-view, picker, and atomic drop-intent APIs.
- Updated dependencies [[`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33)]:
  - @stll/ui@0.9.1

## 0.4.0

### Minor Changes

- [#2533](https://github.com/stella/stella/pull/2533) [`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add typed Group and Sub-group board matrices, reusable swimlane and virtual-cell renderers, atomic drop intents, and persisted board-presentation adapters.

### Patch Changes

- Updated dependencies [[`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff)]:
  - @stll/ui@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`7c0d6fb`](https://github.com/stella/stella/commit/7c0d6fb9003b917202449450bdfd7362d4089bfb), [`a4062b2`](https://github.com/stella/stella/commit/a4062b260031fe8fda587ea7e8bf2e2841349523), [`9c2cc2d`](https://github.com/stella/stella/commit/9c2cc2daff89dda2cc2508e2c1dca6bde834dc57)]:
  - @stll/ui@0.8.0

## 0.3.2

### Patch Changes

- [#2526](https://github.com/stella/stella/pull/2526) [`355d6c1`](https://github.com/stella/stella/commit/355d6c1e48fef5d15f15435bd9ce26a0f88b4b2e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - - @stll/auth-model: Require a verified email address before an organization invitation grants access.
  - @stll/cli: Regenerate the route map for the `properties.preview` capability's access and scope.
  - @stll/workspace-ui: Load person avatar images lazily and without a referrer.
- Updated dependencies [[`746d6f3`](https://github.com/stella/stella/commit/746d6f3ecee8e92aa433bc4b30c5507ed5e3bb53), [`62e2d3e`](https://github.com/stella/stella/commit/62e2d3eda8809f5cd6996cb6e3b1515cd18da1f2)]:
  - @stll/ui@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`26acf32`](https://github.com/stella/stella/commit/26acf32c18edbcd71ebc3f29ba2999676bc90390), [`7f66d10`](https://github.com/stella/stella/commit/7f66d10919fee6037d16fac69a1dff08125cffb8)]:
  - @stll/ui@0.6.0

## 0.3.0

### Minor Changes

- [#2338](https://github.com/stella/stella/pull/2338) [`f9dc04a`](https://github.com/stella/stella/commit/f9dc04afa5045c757a57a31938554a32bde6f984) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxChildren` cap to the condition builder's capabilities; refresh the capability catalog with the bounded request filter arrays.

- [#2333](https://github.com/stella/stella/pull/2333) [`60a11f4`](https://github.com/stella/stella/commit/60a11f4d18e38870f02882ef41a6d39b925eb343) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxSorts` cap to `SortChips`; refresh the capability catalog with the separate view-sort bound and the raised property cap.

### Patch Changes

- Updated dependencies [[`3bf2e63`](https://github.com/stella/stella/commit/3bf2e63080436a16dad0a46958049850ec5831c4)]:
  - @stll/ui@0.5.1

## 0.2.1

### Patch Changes

- Updated dependencies [[`f43667b`](https://github.com/stella/stella/commit/f43667bfa8dccca5f4c4e622bf6f80972ed349d6)]:
  - @stll/ui@0.5.0

## 0.2.0

### Minor Changes

- [#2322](https://github.com/stella/stella/pull/2322) [`2b1e874`](https://github.com/stella/stella/commit/2b1e87435afbcc9ebdf1aa2e2e46d2ca4a07cf5f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish a controlled, accessible saved-view switcher with bidi-aware reordering.

## 0.1.0

### Minor Changes

- [#2296](https://github.com/stella/stella/pull/2296) [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the reusable money, calculation, and workspace presentation packages
  with explicit build and export contracts.

### Patch Changes

- Updated dependencies [[`77825df`](https://github.com/stella/stella/commit/77825dfdee54a9d3b065afa3b5504aaa55050bd8), [`d2dcd0f`](https://github.com/stella/stella/commit/d2dcd0f1df22dffc91ba779e6c278b18825f1932), [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1)]:
  - @stll/ui@0.4.0
  - @stll/money@0.1.0
  - @stll/calculations@0.1.0
