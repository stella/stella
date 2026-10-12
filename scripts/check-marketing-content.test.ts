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

test("ignores remote badges and links", () => {
  expect(
    findMissingReadmeImages(
      '<img src="https://img.shields.io/github/issues/stella/stella" alt="Issues" />',
      exists,
    ),
  ).toEqual([]);
});
