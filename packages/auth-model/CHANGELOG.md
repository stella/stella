# @stll/auth-model

## 0.2.4

### Patch Changes

- [#3701](https://github.com/stella/stella/pull/3701) [`3352fca`](https://github.com/stella/stella/commit/3352fca0674fc04408b1594c744f08d036f4422a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Pin the schema contract to Better Auth 1.7.5.

## 0.2.3

### Patch Changes

- [#3458](https://github.com/stella/stella/pull/3458) [`b27b4c2`](https://github.com/stella/stella/commit/b27b4c27edd2d9bfa896c58982eeb16f6b1c6c6c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Pin the contract to Better Auth 1.7.4 and drop `account.issuer`, which the library no longer declares; the retained column is now a host field.

## 0.2.2

### Patch Changes

- [#3460](https://github.com/stella/stella/pull/3460) [`b9b6e04`](https://github.com/stella/stella/commit/b9b6e045f32d43950980cb3472dba75e5bfb8b47) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Record `account.issuer` as nullable in the database and key accounts by `(providerId, accountId)`, the identity index Better Auth links accounts by.

## 0.2.1

### Patch Changes

- [#2526](https://github.com/stella/stella/pull/2526) [`355d6c1`](https://github.com/stella/stella/commit/355d6c1e48fef5d15f15435bd9ce26a0f88b4b2e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - - @stll/auth-model: Require a verified email address before an organization invitation grants access.
  - @stll/cli: Regenerate the route map for the `properties.preview` capability's access and scope.
  - @stll/workspace-ui: Load person avatar images lazily and without a referrer.

## 0.2.0

### Minor Changes

- [#2474](https://github.com/stella/stella/pull/2474) [`8644102`](https://github.com/stella/stella/commit/86441029782024b5364b1adf011152cfed99a755) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe the Better Auth 1.7 issuer identity contract and request resource-scoped OAuth tokens from the CLI.

## 0.1.0

### Minor Changes

- [#2339](https://github.com/stella/stella/pull/2339) [`d4a088d`](https://github.com/stella/stella/commit/d4a088d407f29e9d48ec4d3bbf4c80c3b6f884e6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the portable Better Auth core contract and strict schema parity checks.
