# @stll/docx-utils

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
