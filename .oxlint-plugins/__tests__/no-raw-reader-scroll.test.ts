import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-raw-reader-scroll";

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "reader-surface.ts" });

describe.serial(RULE_NAME, () => {
  test("reports a jump that computes where it lands", async () => {
    const source = [
      `export const _a = (sc: HTMLElement, offset: number) => sc.scrollTo({ top: offset, behavior: "instant" });`,
      `export const _b = (sc: HTMLElement, el: HTMLElement) => sc.scrollTo({ top: el.getBoundingClientRect().top });`,
      `export const _c = (sc: HTMLElement, top: number) => sc.scrollTo({ top });`,
      `export const _d = (sc: HTMLElement | null, top: number) => sc?.scrollTo({ top });`,
      `export const _e = (sc: HTMLElement, top: number) => sc.scrollTo(0, top);`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5]);
  });

  test("accepts the owner, the document's start and held positions", async () => {
    const source = [
      `declare const scrollReaderToBlock: (target: Element, container: Element) => void;`,
      `export const _a = (el: Element, sc: Element) => scrollReaderToBlock(el, sc);`,
      `export const _b = (sc: HTMLElement) => sc.scrollTo({ top: 0, behavior: "instant" });`,
      `export const _c = (sc: HTMLElement, drift: number) => { sc.scrollTop += drift; };`,
      `export const _d = (sc: HTMLElement) => sc.scrollTo({ left: 40 });`,
      `export const _e = (sc: HTMLElement) => sc.scrollIntoView({ block: "center" });`,
      `export const _f = (sc: HTMLElement) => sc.scrollTo(0, 0);`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
