# Desktop bridge version test evidence

## Change

`apps/desktop/tests/bridge-version.ts` reads `BRIDGE_VERSION` directly from
`apps/desktop/src-tauri/src/types.rs`. The golden test's typed snapshot and the
registry Playwright mock use that value. The recorded JSON fixture stays at
version 19; its assertion reports both source paths and the required fixture
update when it drifts.

The existing Rust RPC generator emits declarations, not constants. Extending it
would modify `types.rs` and trigger the bridge-surface bump guard for a test-only
change. Reusing the existing test's reader avoids that protocol bump and reads
the Rust value without requiring regeneration. No generator changed.

## Commands and results

Initial execution checks ran on a remote runner, with the working directories
below; spec collection ran locally without starting a server. No local
development stack ran.

| Directory       | Command                                                                                                                                                                                                                                       | Result                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`  | `bun run test tests/rpc.golden.test.ts tests/browser/registry-interactions.playwright.spec.ts`                                                                                                                                                | Exit 0: 42 tests passed, 188 assertions. The package script excludes Playwright specs.                                                                                                           |
| `apps/desktop`  | `bun run test:browser tests/browser/registry-interactions.playwright.spec.ts`                                                                                                                                                                 | 88 cases passed before the Vite server's Node process aborted with `Lazy deopt after a fast API call with return value is unsupported`. Interrupted after the runtime crash; transport exit 255. |
| `apps/desktop`  | `NODE_OPTIONS=--jitless bun run test:browser tests/browser/registry-interactions.playwright.spec.ts --max-failures=1`                                                                                                                         | Interrupted (transport exit 255): the previous crashed Vite process remained alive and blocked startup. Cleaned up that process before the next retry.                                           |
| `apps/desktop`  | `bun run test tests/rpc.golden.test.ts -t "snapshot fixture advertises the native bridge contract revision"`                                                                                                                                  | Mutation: exit 1, one test failed; expected 20, received 19.                                                                                                                                     |
| `apps/desktop`  | `bun run test tests/rpc.golden.test.ts tests/browser/registry-interactions.playwright.spec.ts`                                                                                                                                                | After restoring Rust: exit 0, 42 tests passed, 188 assertions.                                                                                                                                   |
| Repository root | `bun scripts/run-oxfmt.ts --check apps/desktop/tests/bridge-version.ts apps/desktop/tests/rpc.golden.test.ts apps/desktop/tests/browser/registry-interactions.playwright.spec.ts && bash scripts/check-bridge-version.sh && git diff --check` | Exit 0: all three files formatted, no bridge-surface changes, no whitespace errors.                                                                                                              |

Additional browser checks (`apps/desktop`):

- `NODE_OPTIONS=--no-turbo-fast-api-calls bun run test:browser tests/browser/registry-interactions.playwright.spec.ts --max-failures=1`
  on the remote runner: cancelled
  while still queued (transport exit 255); no test result.
- `bun run test:browser tests/browser/registry-interactions.playwright.spec.ts --list`
  locally: exit 0, collected all 148 tests and evaluated the mock's reader import.

Full browser execution remains unverified after the runtime crash; collection
is not a substitute for a browser pass.

The mutation changed only `pub const BRIDGE_VERSION: u32 = 19;` to
`pub const BRIDGE_VERSION: u32 = 20;` in Rust. The fixture stayed unchanged. The
failure message was:

```text
apps/desktop/fixtures/rpc/app-snapshot.json bridgeVersion must match BRIDGE_VERSION in apps/desktop/src-tauri/src/types.rs; update the recorded fixture after a bridge version bump
Expected: 20
Received: 19
```

Restored the Rust constant to 19. `git diff --exit-code --
apps/desktop/src-tauri/src/types.rs apps/desktop/fixtures/rpc/app-snapshot.json`
returned exit 0, confirming neither wire source changed.

`rg -n 'bridgeVersion|bridge_version|BRIDGE_VERSION' apps/desktop/tests` found
the two snapshot literals, the existing fixture assertion, and a missing-field
negative test. Both literals now derive from the reader; the negative test
continues to remove the field.

Local `bun scripts/run-oxfmt.ts --check apps/desktop/tests/bridge-version.ts
apps/desktop/tests/rpc.golden.test.ts
apps/desktop/tests/browser/registry-interactions.playwright.spec.ts` could not
run because formatter dependencies were incomplete; the remote check above
passed. Local `git diff --check` passed. After dependency bootstrap through the
repository install wrapper, `bun scripts/run-oxfmt.ts CLOUD_REPORT.md` passed
(exit 0). Setup introduced no tracked changes.

Pre-commit lint initially rejected the extracted native `TypeError` with
`no-bare-error`. The reader now uses `panic()` for a missing Rust declaration.
After this correction, locally repeated (from `apps/desktop`):

- `bun run test tests/rpc.golden.test.ts tests/browser/registry-interactions.playwright.spec.ts`:
  exit 0, 42 passed, 188 assertions, both before and after the final mutation.
- `bun run test tests/rpc.golden.test.ts -t "snapshot fixture advertises the native bridge contract revision"`:
  with Rust temporarily at 20, exit 1, one failure with expected 20 / received 19;
  restored Rust to 19 immediately afterward.
- `bun run test:browser tests/browser/registry-interactions.playwright.spec.ts --list`:
  exit 0, 148 tests collected.

Full verification, lint, typecheck, and builds are left to CI under the
repository's lightweight-command guidance. RPC generation/check is unnecessary
because the generator and generated declarations are unchanged.

## Open questions

None.
