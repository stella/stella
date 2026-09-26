# @stll/runtime-mode

Runtime mode resolution: whether a server process runs strict or with explicit
local development access.

## What lives here

The one reader of `NODE_ENV` and `STELLA_LOCAL_DEV` for server processes, and
the tests that pin its behaviour.

- A process is `open` only when the running environment sets `NODE_ENV` to
  `development` or `test` **and** `STELLA_LOCAL_DEV=1`, in a build that is not
  a release. Every other combination is `strict`.
- An opt-in that cannot be honoured (another `NODE_ENV`, a value other than
  `1`, a release build) fails startup.
- Release builds pass `--define __STELLA_RELEASE__=true` to `bun build`.
- Both keys are read through an alias of the environment object, so a bundler
  cannot replace them with build-time values.

Never put `STELLA_LOCAL_DEV` in a `.env` file: Bun loads `.env` from the
working directory, so a copied file would opt a deployment into local
development mode.

## What does not

App wiring: each app resolves the mode once at startup and decides what its
own local development capabilities are.

## License

Apache-2.0
