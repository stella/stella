// oxlint-disable-next-line no-independent-fallback-state/no-independent-fallback-state -- fixture: direct partial state loses document proof
const _partial = { fallbackContentHash: null };
// oxlint-disable-next-line no-independent-fallback-state/no-independent-fallback-state, no-useless-computed-key -- fixture: computed column still bypasses the owner
const _computed = { ["fallbackIdentityKey"]: "key" };
// expect-clean: no-independent-fallback-state/no-independent-fallback-state
const _read = { fallbackDocumentHash: true, fallbackIdentityKey: { isNull: true } };
export const __fallbackStateFixture = {_partial, _computed, _read};

declare const _stored: { fallbackDocumentHash: string | null };
// oxlint-disable-next-line no-independent-fallback-state/no-independent-fallback-state -- fixture: member mutation bypasses complete state
_stored.fallbackDocumentHash = null;
