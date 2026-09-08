# @stll/template-conditions

## 0.5.0

### Minor Changes

- [#3137](https://github.com/stella/stella/pull/3137) [`63f962b`](https://github.com/stella/stella/commit/63f962b5ae86e0cf6cd6abc3342e68785b0951d5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The package gains the writer half of the template language. `filtersFromFieldConfig` / `arrayFiltersFromFieldConfig` turn a field's configuration into the filter chain that declares it, over a structural `MarkerFieldConfig` both the api and the editor satisfy, so one mapping serves every surface that configures a field. `renderValueMarker`, `renderForOpener`, `renderConditionTag` and `renderFilterChain` produce the marker text the scanner reads, and `isWritableMarkerText` / `isWritableMarkerLiteral` / `unwritableFilterValues` name the values the grammar has no spelling for (braces, exponent notation).

  Composite field values are gone: `renderComposite` and `PartConfig` are removed, and `DeterministicFieldConfig` no longer carries `parts` or `format`.

  A quoted argument's `\`-escapes are now recognized by the span pattern as well as by the argument scanner, so `label("she said \"yes\"")` is one marker instead of three.

## 0.4.0

### Minor Changes

- [#3101](https://github.com/stella/stella/pull/3101) [`c69d0a1`](https://github.com/stella/stella/commit/c69d0a11b544ac75c7362483428c5a2009676c81) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The template marker grammar is the docxtpl dialect of Jinja: `{{ path | filter(…) }}` value markers whose filter chain carries the field configuration, `{% if %}` / `{% elif %}` / `{% else %}` / `{% endif %}`, `{% for alias in path %}` … `{% endfor %}` with `loop.*` counters, `{%p %}` and `{%tr %}` placement, and `clause()` / `num()` / `ref()` functions. The old `{{#each}}` / `{{#if}}` / `{{@…}}` forms are rejected as `legacy_marker` with the exact replacement named. The CLI catalog follows the tool schemas: composites (`parts`, `format`) leave the agent wire and a maximum constraint is at least 1.

## 0.3.0

### Minor Changes

- [#3055](https://github.com/stella/stella/pull/3055) [`7823e0e`](https://github.com/stella/stella/commit/7823e0e8100e55bfafaf025efc863d3ec8e50c7f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `detectRowBlockPair` names the row block a table row declares when a `{{#each}}`
  / `{{#if}}` opener prefixes one cell's text and its closer suffixes a later
  cell's text in the same row. Both the fill pipeline and the authoring scorer
  read the placement from this one function, so a row that repeats and a row the
  scorer accepts cannot disagree.

- [#3033](https://github.com/stella/stella/pull/3033) [`291214c`](https://github.com/stella/stella/commit/291214c19072c7373cf9cb056797e1a2ac43f809) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `classifyMarkerDefect` names the authoring mistake behind a `{{...}}` span the grammar rejects — `unknown_directive` for a `{{#...}}` / `{{/...}}` token that is not a directive, `bracket_index` for `{{items[0].name}}` — and `MARKER_DEFECT_KINDS` lists those kinds so a consumer can derive its own codes from them instead of repeating the list. A span `classifyMarker` accepts is never a defect, so the directive grammar stays the only authority on which tokens exist.

## 0.2.2

### Patch Changes

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

- [#2952](https://github.com/stella/stella/pull/2952) [`a652d96`](https://github.com/stella/stella/commit/a652d967f17d7f90e94c16e1b2f50904ec4b78b6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Document why the path walker's record predicate accepts arrays, and cover dotted paths that index one.
- Updated dependencies [[`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3)]:
  - @stll/conditions@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [[`45b076c`](https://github.com/stella/stella/commit/45b076ca5ea2c97b1534e7ee2493b0272064194b), [`67baa75`](https://github.com/stella/stella/commit/67baa75ca462fdb72ef9709e7dd3c7752a03411f)]:
  - @stll/conditions@0.3.0

## 0.2.0

### Minor Changes

- [#1839](https://github.com/stella/stella/pull/1839) [`3eaa322`](https://github.com/stella/stella/commit/3eaa322e8683cb04ba1d9252cbbad2626835060c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose canonical directive and date-format values for API and UI consumers.

- [#1859](https://github.com/stella/stella/pull/1859) [`a01e003`](https://github.com/stella/stella/commit/a01e003886a5beaaa2def9632ddd064afd68da9a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the supported numeric formula function names and their type.

### Patch Changes

- Updated dependencies [[`b4b7cae`](https://github.com/stella/stella/commit/b4b7caedbe543ae3c1ff14e4eec96a27964a1680), [`7e53091`](https://github.com/stella/stella/commit/7e53091060df479830961d7be7948f2bdef739c2)]:
  - @stll/conditions@0.2.0

## 0.1.0

- Initial public release.
