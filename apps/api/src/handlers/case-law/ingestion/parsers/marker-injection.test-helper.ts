import { panic } from "better-result";
import { expect } from "bun:test";
import * as cheerio from "cheerio";
import { isCDATA, isTag, isText } from "domhandler";
import type { AnyNode } from "domhandler";
import fc from "fast-check";

import { normalizeUnicode } from "@stll/text-normalize";

export const markerPlan = fc.record({
  nonce: fc.integer({ min: 0, max: 2_000_000_000 }),
  placements: fc.array(
    fc.record({
      slot: fc.nat(),
      offset: fc.nat(),
      spelling: fc.constantFrom("ascii", "diacritics", "nbsp"),
    }),
    { minLength: 1, maxLength: 8 },
  ),
});
type MarkerPlan = ReturnType<typeof markerPlan.generate>["value"];
type MarkerSlot = { read: () => string; write: (value: string) => void };
const normalize = (text: string): string =>
  normalizeUnicode(text, "NFC").replace(/\s+/gu, " ");

const injectMarkers = (
  slots: readonly MarkerSlot[],
  plan: MarkerPlan,
): string[] => {
  expect(slots.length).toBeGreaterThan(0);
  const edits = new Map<
    number,
    { offset: number; marker: string; ordinal: number }[]
  >();
  for (const [ordinal, placement] of plan.placements.entries()) {
    const slotIndex = placement.slot % slots.length;
    const slot = slots.at(slotIndex);
    expect(slot).toBeDefined();
    if (slot === undefined) {
      return panic("Marker slot must belong to the source");
    }
    const stem = `qzmarker${plan.nonce}v${ordinal}x`;
    const suffixes = {
      ascii: "wordqzend",
      diacritics: "žluťoučkýqzend",
      nbsp: "žluťoučký\u00a0kůňqzend",
    } as const;
    const marker = `${stem}${suffixes[placement.spelling]}`;
    expect(slots.some(({ read }) => read().includes(marker))).toBe(false);
    const offset = placement.offset % (Array.from(slot.read()).length + 1);
    const group = edits.get(slotIndex);
    const edit = { offset, marker, ordinal };
    if (group === undefined) {
      edits.set(slotIndex, [edit]);
    } else {
      group.push(edit);
    }
  }
  const ordered: string[] = [];
  for (const [slotIndex, slot] of slots.entries()) {
    const group = edits.get(slotIndex);
    if (group === undefined) {
      continue;
    }
    group.sort(
      (left, right) =>
        left.offset - right.offset || left.ordinal - right.ordinal,
    );
    const characters = Array.from(slot.read());
    let output = "";
    let previous = 0;
    for (const { offset, marker } of group) {
      output += `${characters.slice(previous, offset).join("")} ${marker} `;
      previous = offset;
      ordered.push(marker);
    }
    slot.write(output + characters.slice(previous).join(""));
  }
  return ordered;
};

type InjectMarkupOptions = {
  source: string;
  selector: string;
  excludedSelector: string;
  plan: MarkerPlan;
  xml?: boolean;
};
export const injectMarkupMarkers = ({
  source,
  selector,
  excludedSelector,
  plan,
  xml = false,
}: InjectMarkupOptions) => {
  const $ = cheerio.load(source, xml ? { xml: true } : {});
  const roots = $(selector).toArray();
  const visited = new Set<AnyNode>();
  const slots: MarkerSlot[] = [];
  const walk = (node: AnyNode): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    if (isText(node)) {
      slots.push({
        read: () => node.data,
        write: (text) => {
          node.data = text;
        },
      });
      return;
    }
    if (isCDATA(node)) {
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (!isTag(node) || $(node).is(excludedSelector)) {
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const root of roots) {
    if ($(root).parents(excludedSelector).length === 0) {
      walk(root);
    }
  }
  const markers = injectMarkers(slots, plan);
  return { source: $.html(), markers, $ };
};

export const expectMarkerRetention = (
  text: string,
  markers: readonly string[],
): void => {
  const normalized = normalize(text);
  let previous = -1;
  for (const marker of markers) {
    const value = normalize(marker);
    const offset = normalized.indexOf(value);
    expect(offset).toBeGreaterThan(previous);
    expect(normalized.lastIndexOf(value)).toBe(offset);
    previous = offset;
  }
};
