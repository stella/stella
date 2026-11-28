# @stll/docx-utils

## 0.3.7

### Patch Changes

- [#9713](https://github.com/stella/stella/pull/9713) [`71d2410`](https://github.com/stella/stella/commit/71d24108c5e0e18c3eac83169ec37caaa8c0427b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.50.2.

- [#9684](https://github.com/stella/stella/pull/9684) [`e66f25f`](https://github.com/stella/stella/commit/e66f25f1fac5714c155ecfee8b446dfc61f6b697) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.49.0.

- [#9716](https://github.com/stella/stella/pull/9716) [`7789168`](https://github.com/stella/stella/commit/77891689ac8d945e9adb351e019b72f77278987c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.51.0.

- [#9691](https://github.com/stella/stella/pull/9691) [`0ba8fc0`](https://github.com/stella/stella/commit/0ba8fc05dbcb94f2dc8297c272f5e8a8fbebd0e7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.50.0.

## 0.3.6

### Patch Changes

- [#9648](https://github.com/stella/stella/pull/9648) [`3dfee80`](https://github.com/stella/stella/commit/3dfee8042f810d849cdd696dfe0dec693618173c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.48.1.

## 0.3.5

### Patch Changes

- [#9634](https://github.com/stella/stella/pull/9634) [`c08a3b2`](https://github.com/stella/stella/commit/c08a3b28e344ff2936dd593dcb7eca2f31d618e6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.48.0.

- [#9618](https://github.com/stella/stella/pull/9618) [`6fb0dbc`](https://github.com/stella/stella/commit/6fb0dbcdf7ebc895fafb33ffd02a6eae4bab97fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.47.0.

## 0.3.4

### Patch Changes

- [#9581](https://github.com/stella/stella/pull/9581) [`3b39de5`](https://github.com/stella/stella/commit/3b39de5b80149b8686d9669e7dee0ed245df367f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.46.0.

## 0.3.3

### Patch Changes

- [#9539](https://github.com/stella/stella/pull/9539) [`2d12d35`](https://github.com/stella/stella/commit/2d12d35df5dc3406ae6014cd473f17849c8d5761) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.45.1.

## 0.3.2

### Patch Changes

- [#9314](https://github.com/stella/stella/pull/9314) [`61f332d`](https://github.com/stella/stella/commit/61f332dbcf39947f932279dc491a32682c50ff3e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build on `@stll/docx-core` 0.44.0.

## 0.3.1

### Patch Changes

- [#8153](https://github.com/stella/stella/pull/8153) [`8c87766`](https://github.com/stella/stella/commit/8c87766f58f7e610b1ba6922a2c0ba210e9026b4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Depends on `@stll/docx-core` 0.43.0.

- [#8537](https://github.com/stella/stella/pull/8537) [`001c640`](https://github.com/stella/stella/commit/001c640e64cb00e3948bdf68a18a40347c65a40f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Build declarations through the native tsrs API supported by tsdown 0.23.7, resolving the compiler from each package.

## 0.3.0

### Minor Changes

- [#7331](https://github.com/stella/stella/pull/7331) [`f0709d0`](https://github.com/stella/stella/commit/f0709d04e3894fdf4ee752a82463ce577eeb65d6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use docx-core ZIP for shared bounded archive loading. Remove the JSZip-specific extraction, repacking and entry-writing helpers.

## 0.2.0

### Minor Changes

- [#5788](https://github.com/stella/stella/pull/5788) [`f91950d`](https://github.com/stella/stella/commit/f91950daaa6afc70fe0336669f15945abe2988d1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `writeZipEntry`, which UTF-8 encodes text entries in one pass before handing them to JSZip. JSZip's own string encoding works in 16 KiB pieces and turns a character outside the Basic Multilingual Plane (such as an emoji) that straddles a piece boundary into two replacement characters.

## 0.1.5

### Patch Changes

- [#4619](https://github.com/stella/stella/pull/4619) [`34c5cac`](https://github.com/stella/stella/commit/34c5cac979a5b544a345ceaed8fde5c7355627a2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose a shared catalogue of office archive formats and identity metadata fields.

## 0.1.4

### Patch Changes

- [#4231](https://github.com/stella/stella/pull/4231) [`42355cb`](https://github.com/stella/stella/commit/42355cb30b440c58ef5f62e305b1b4b87da67a96) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Ship jszip 3.10.2 from the catalog.

## 0.1.3

### Patch Changes

- [#4259](https://github.com/stella/stella/pull/4259) [`7c7ead9`](https://github.com/stella/stella/commit/7c7ead9d1486972a050bbb85a8afeb54d0b7a3d2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Tighten input handling.

## 0.1.2

### Patch Changes

- [#3163](https://github.com/stella/stella/pull/3163) [`50a59c1`](https://github.com/stella/stella/commit/50a59c17a22fb018fd93c7608dd3055181d1da2c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect and remove attached Word template relationships from DOCX packages.

## 0.1.1

### Patch Changes

- [#1866](https://github.com/stella/stella/pull/1866) [`e573f31`](https://github.com/stella/stella/commit/e573f31ae6c0721c63763347ebadf6f28c3606e8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Make the TypeScript source export directly loadable by Node and Vite SSR.

## 0.1.0

- Initial public release.
