# @stll/workspace-ui

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
