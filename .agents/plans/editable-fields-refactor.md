# Editable Fields Refactor

## Goal

Each field type (text, date, single-select, multi-select, int, file) has ONE
shared component that handles both display and edit modes. This component is
used everywhere: table cells, PDF right panel, inspector, kanban cards, overview.

The field type discriminant determines which widget renders. If you change the
editing UX for a field type, it changes everywhere. Type-safe: you cannot render
a field without its correct editor.

## Architecture

```
packages/ui/src/components/editable-field/
  index.ts           -- re-export
  editable-field.tsx  -- discriminated union dispatcher
  text-field.tsx      -- textarea / inline text
  date-field.tsx      -- date picker
  select-field.tsx    -- dropdown (single-select)
  multi-select-field.tsx -- multi-select dropdown with chips
  int-field.tsx       -- number input with optional currency
```

### API

```tsx
<EditableField
  field={field}           // WorkspaceField (has .content with discriminant)
  property={property}     // WorkspaceProperty (has .content.type, .tool)
  onSave={(content) => {}}  // called with new FieldContent
  readonly?: boolean
/>
```

The component:
1. Reads `property.content.type` to pick the right widget
2. Shows display mode by default (matches current CellResult look)
3. On click/focus, switches to edit mode with native control
4. On blur/Enter/escape, commits or cancels
5. Calls `onSave` with the new value

### Field type → Widget mapping

| Type | Display | Edit |
|------|---------|------|
| text | Inline text, truncated | Textarea (auto-grow) |
| date | Formatted date string | Date picker |
| single-select | Colored chip | Dropdown with options |
| multi-select | Colored chips row | Multi-select dropdown |
| int | Formatted number | Number input + currency selector |
| file | File icon + name | Not editable inline |

### Migration path

1. Build `EditableField` in `packages/ui`
2. Replace `CellResult` usages in table cells with `EditableField`
3. Replace `FieldInfo` in PDF right panel with `EditableField`
4. Replace inspector field rendering with `EditableField`
5. Remove old `CellResult`, `FieldInfo` components

### Current issues to fix

- "Odpověď:" (Answer:) label prefix is shown for all fields, only makes sense
  for AI-extracted fields
- Accordion single-select behavior: opening one field closes others
- No inline editing: all fields are read-only in the right panel
- Multi-select shows as flat chips, not as a proper multi-select dropdown
- Date shows as text, not as a date picker
- No way to add a new field from the right panel

### Constraints

- Must work with React Compiler (no manual memoization)
- Use coss (Base UI) primitives where possible
- Field content types are defined in `apps/web/src/lib/types.ts`
- Mutations go through `useUpsertField` from entities mutations
- All labels must be i18n'd
