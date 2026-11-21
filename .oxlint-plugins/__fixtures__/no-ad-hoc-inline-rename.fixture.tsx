import { InlineRenameInput } from "@stll/ui/inline-rename";
import { Input as TextInput } from "@stll/ui/input";

export const NativeRename = ({ rename, editing }) =>
  editing && (
    // oxlint-disable-next-line no-ad-hoc-inline-rename/no-ad-hoc-inline-rename -- fixture: native rename handlers must use the shared owner
    <input
      onBlur={rename.commit}
      onKeyDown={rename.onKeyDown}
      value={rename.draft}
    />
  );

export const AliasedRename = ({ rename, editing }) =>
  editing && (
    // oxlint-disable-next-line no-ad-hoc-inline-rename/no-ad-hoc-inline-rename -- fixture: aliased UI imports cannot bypass the census
    <TextInput
      onBlur={rename.commit}
      onKeyDown={rename.onKeyDown}
      value={rename.draft}
    />
  );

export const AnonymousInlineEditor = ({
  commit,
  handleKeyDown,
  draft,
  editing,
}) =>
  editing && (
    // oxlint-disable-next-line no-ad-hoc-inline-rename/no-ad-hoc-inline-rename -- fixture: anonymous view-to-edit fields must use the shared owner
    <input autoFocus onBlur={commit} onKeyDown={handleKeyDown} value={draft} />
  );

export const SharedRename = ({ rename }) => (
  // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
  <InlineRenameInput
    onCommit={rename.commit}
    onCancel={rename.cancel}
    value={rename.draft}
  />
);

export const RenameConfirmation = ({ rename }) => (
  // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
  <TextInput
    autoFocus
    onChange={rename.setConfirmation}
    value={rename.confirmation}
  />
);

export const OrdinaryField = ({ validate, handleKeyDown, value }) => (
  // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
  <input onBlur={validate} onKeyDown={handleKeyDown} value={value} />
);

export const PermanentRenameField = ({ rename }) => (
  // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
  <TextInput
    onBlur={rename.commit}
    onKeyDown={rename.onKeyDown}
    value={rename.draft}
  />
);

export const NumericEditor = ({ rename, editing }) =>
  editing && (
    // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
    <TextInput
      autoFocus
      inputMode="numeric"
      onBlur={rename.commit}
      onKeyDown={rename.onKeyDown}
      value={rename.draft}
    />
  );

export const MultilineEditor = ({ rename, editing }) =>
  editing && (
    // expect-clean: no-ad-hoc-inline-rename/no-ad-hoc-inline-rename
    <textarea
      autoFocus
      onBlur={rename.commit}
      onKeyDown={rename.onKeyDown}
      value={rename.draft}
    />
  );
