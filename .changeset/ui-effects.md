---
"@stll/ui": minor
---

The sanctioned React effect hooks are exported from `@stll/ui/effects`: `useMountEffect`, `useExternalSyncEffect`, `useLayoutSyncEffect` and `useMountLayoutEffect` for syncing with systems outside React, `useLatest` and `useLatestCallback` for reading the latest committed value or callback (`useLatestCallback` keeps one identity whether or not the React Compiler runs), `useIsMounted` and `useHasMounted` for mount state, and `useKeyedState` for local state that starts over when a key changes. `@stll/ui/use-latest` now resolves to the same module.
