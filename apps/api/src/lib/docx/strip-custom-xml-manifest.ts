/**
 * Remove a template's legacy custom XML manifest.
 *
 * Stella used to keep field metadata beside the markers, in a custom XML part
 * (`customXml/item{N}.xml`) of the DOCX. The markers carry the configuration
 * now and nothing reads that part, but documents written before the cutover —
 * and the pack templates shipped with one — still hold it, and a filled
 * document must not carry template metadata out of the workspace. So the fill
 * pipeline strips it, and only that.
 *
 * A part is "ours" only when its root element is `<template>` in the URN below,
 * so a foreign custom XML part (Word bibliography, content-control bindings,
 * SharePoint metadata) that merely mentions the URI is never removed.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { compareCodeUnit } from "@stll/collation";

const MANIFEST_NS = "urn:stella:template:v1";

// Custom XML parts live in numbered slots; the props part and its relationship
// travel with the data part, so removing one means removing all three.
const customXmlItemPathForIndex = (index: string): string =>
  `customXml/item${index}.xml`;
const customXmlPropsPathForIndex = (index: string): string =>
  `customXml/itemProps${index}.xml`;
const customXmlRelsPathForIndex = (index: string): string =>
  `customXml/_rels/item${index}.xml.rels`;

/** Matches only data parts (`item{N}.xml`), where a manifest can live. */
const CUSTOM_XML_DATA_RE = /^customXml\/item(?<index>\d+)\.xml$/u;

const parseCustomXmlSlotIndex = (index: string): number | null => {
  const slot = Number(index);
  return Number.isSafeInteger(slot) && slot > 0 ? slot : null;
};

/** Escape every regex meta-character (including `\`) for literal matching. */
const escapeRegExp = (value: string): string =>
  value.replaceAll(/[\\^$.*+?()[\]{}|]/gu, (match) => `\\${match}`);

const CONTENT_TYPES_PATH = "[Content_Types].xml";

type CustomXmlSlot = { index: string; safeIndex: number | null };

const compareCustomXmlSlots = (
  left: CustomXmlSlot,
  right: CustomXmlSlot,
): number => {
  if (left.safeIndex !== null && right.safeIndex !== null) {
    return left.safeIndex - right.safeIndex;
  }
  if (left.safeIndex !== null) {
    return -1;
  }
  if (right.safeIndex !== null) {
    return 1;
  }
  if (left.index.length !== right.index.length) {
    return left.index.length - right.index.length;
  }
  // index is a DOCX custom-XML part slot index, not display text.
  return compareCodeUnit(left.index, right.index);
};

/** True when this part's root element is the one Stella used to write. */
const isStellaManifestPart = (xml: string): boolean => {
  const parsed = slimdom.parseXmlDocument(xml);
  const root = parsed.documentElement;
  return root?.namespaceURI === MANIFEST_NS && root.localName === "template";
};

/** The slot the Stella manifest occupies, lowest index first so the choice is
 *  deterministic regardless of zip order. */
const findManifestSlot = async (zip: JSZip): Promise<CustomXmlSlot | null> => {
  const candidates = Object.entries(zip.files).flatMap(([path, entry]) => {
    const index = CUSTOM_XML_DATA_RE.exec(path)?.groups?.["index"];
    return index === undefined
      ? []
      : [{ index, safeIndex: parseCustomXmlSlotIndex(index), entry }];
  });
  const slots = await Promise.all(
    candidates.map(async ({ entry, index, safeIndex }) => ({
      index,
      safeIndex,
      ours: isStellaManifestPart(await entry.async("string")),
    })),
  );
  return (
    slots
      .filter(({ ours }) => ours)
      .toSorted(compareCustomXmlSlots)
      .at(0) ?? null
  );
};

const removeManifestSlot = async (
  zip: JSZip,
  slot: CustomXmlSlot,
): Promise<void> => {
  const propsPath = customXmlPropsPathForIndex(slot.index);

  zip.remove(customXmlItemPathForIndex(slot.index));
  zip.remove(propsPath);
  zip.remove(customXmlRelsPathForIndex(slot.index));

  // Clean up empty customXml directory entries
  const customXmlDir = "customXml/";
  const remaining = zip.file(new RegExp(`^${customXmlDir}`, "u"));
  if (remaining.length === 0) {
    zip.remove("customXml/_rels/");
    zip.remove(customXmlDir);
  }

  const ctEntry = zip.file(CONTENT_TYPES_PATH);
  if (!ctEntry) {
    return;
  }

  const ctXml = await ctEntry.async("string");
  zip.file(
    CONTENT_TYPES_PATH,
    ctXml.replace(
      new RegExp(
        `<Override[^>]*PartName=["']/${escapeRegExp(propsPath)}["'][^>]*/>`,
        "u",
      ),
      "",
    ),
  );
};

/**
 * Remove the legacy Stella manifest from a DOCX buffer. Safe to call on
 * buffers that never had one: the same bytes come back.
 */
export const stripManifest = async (docxBuffer: Buffer): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(docxBuffer);

  const found = await findManifestSlot(zip);
  if (!found) {
    return docxBuffer;
  }

  // Remove only our slot's part files; foreign custom XML parts stay intact.
  await removeManifestSlot(zip, found);

  const output = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(output);
};
