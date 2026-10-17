// oxlint-disable-next-line no-direct-folio-snapshot-retirement/no-direct-folio-snapshot-retirement -- fixture: direct revision reset loses the recovery marker
const _reset = { yjsSnapshotRevision: 0 };
// oxlint-disable-next-line no-direct-folio-snapshot-retirement/no-direct-folio-snapshot-retirement -- fixture: direct snapshot retirement bypasses the owner
const _clear = { savedSnapshotCut: null };
// expect-clean: no-direct-folio-snapshot-retirement/no-direct-folio-snapshot-retirement
const _store = { yjsSnapshotRevision: 1, yjsSnapshotSizeBytes: 12 };

export const __noDirectFolioSnapshotRetirementFixture = {
  _reset,
  _clear,
  _store,
};
