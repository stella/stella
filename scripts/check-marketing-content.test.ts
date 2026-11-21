import { expect, test } from "bun:test";

import { findMissingReadmeImages } from "./check-marketing-content";

const existing = new Set([
  ".github/assets/banners/stella.webp",
  "apps/landing/public/media/products/agent.png",
  "apps/landing/public/media/products/agent-dark.png",
]);
const exists = (relativePath: string) => existing.has(relativePath);

test("accepts README images that exist, in both img src and picture srcset", () => {
  expect(
    findMissingReadmeImages(
      [
        '<img src=".github/assets/banners/stella.webp" alt="stella" />',
        "<picture>",
        '  <source media="(prefers-color-scheme: dark)" srcset="apps/landing/public/media/products/agent-dark.png" />',
        '  <img src="apps/landing/public/media/products/agent.png" alt="" />',
        "</picture>",
      ].join("\n"),
      exists,
    ),
  ).toEqual([]);
});

test("reports a renamed capture once, whether light or dark", () => {
  expect(
    findMissingReadmeImages(
      [
        '<source srcset="apps/landing/public/media/products/chat-dark.png" />',
        '<img src="apps/landing/public/media/products/chat.png" />',
        '<img src="apps/landing/public/media/products/chat.png" />',
      ].join("\n"),
      exists,
    ),
  ).toEqual([
    "apps/landing/public/media/products/chat-dark.png",
    "apps/landing/public/media/products/chat.png",
  ]);
});

test("ignores remote badges and links, including protocol-relative ones", () => {
  expect(
    findMissingReadmeImages(
      [
        '<img src="https://img.shields.io/github/issues/stella/stella" alt="Issues" />',
        '<img src="//cdn.example.com/logo.png" />',
        "![Deploy](https://railway.com/button.svg)",
      ].join("\n"),
      exists,
    ),
  ).toEqual([]);
});

test("checks every srcset candidate without its descriptor", () => {
  expect(
    findMissingReadmeImages(
      '<source srcset="apps/landing/public/media/products/agent.png 1x, apps/landing/public/media/products/agent@2x.png 2x" />',
      exists,
    ),
  ).toEqual(["apps/landing/public/media/products/agent@2x.png"]);
});

test("checks Markdown images", () => {
  expect(
    findMissingReadmeImages(
      [
        '![agent](apps/landing/public/media/products/agent.png "The agent")',
        "![gone](docs/missing.png)",
      ].join("\n"),
      exists,
    ),
  ).toEqual(["docs/missing.png"]);
});

test("resolves reference-style images through their definitions", () => {
  expect(
    findMissingReadmeImages(
      [
        "![Tour][capture] ![Agent] ![Gone][missing]",
        "",
        "[capture]: apps/landing/public/media/products/agent.png",
        '[agent]: <apps/landing/public/media/products/agent-dark.png> "Dark"',
        "[Missing]: docs/missing.png",
      ].join("\n"),
      exists,
    ),
  ).toEqual(["docs/missing.png"]);
});

test("checks the file behind theme fragments and query strings", () => {
  expect(
    findMissingReadmeImages(
      [
        "![agent](apps/landing/public/media/products/agent-dark.png#gh-dark-mode-only)",
        '<img src="apps/landing/public/media/products/agent.png?raw=true" />',
        "![gone](docs/missing.png#gh-light-mode-only)",
      ].join("\n"),
      exists,
    ),
  ).toEqual(["docs/missing.png#gh-light-mode-only"]);
});
