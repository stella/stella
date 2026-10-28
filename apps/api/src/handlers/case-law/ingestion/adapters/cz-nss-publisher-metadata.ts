import { load } from "cheerio";
import type { AnyNode } from "domhandler";

import {
  ownTableRows,
  visibleHtmlText,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { MetadataUrlDefect, toMetadataUrl } from "@/api/lib/sanitize-url";

const NSS_DETAIL_ORIGIN = "https://vyhledavac.nssoud.cz";
const FIELD_ATTRIBUTE = "data-field-id";
const FIELD_VALUES_SELECTOR = ".det-textval";

const publisherReferenceUrl = (raw: string | undefined) => {
  const direct = toMetadataUrl(raw, "decoded");
  if (
    !(direct instanceof MetadataUrlDefect) ||
    direct.reason !== "invalid-url" ||
    raw === undefined ||
    !URL.canParse(raw, NSS_DETAIL_ORIGIN)
  ) {
    return direct;
  }
  return toMetadataUrl(new URL(raw, NSS_DETAIL_ORIGIN).href, "constructed");
};

/** Keep occurrences and table tuples: related proceedings must not trade cells. */
export const extractNssPublisherMetadata = (html: string) => {
  const $ = load(html);
  const publisherFields = new Map<string, string[]>();
  // A header without a value states a column, not its label as legal content.
  for (const element of $(`[${FIELD_ATTRIBUTE}]`).toArray()) {
    const field = $(element).attr(FIELD_ATTRIBUTE);
    if (field !== undefined && !publisherFields.has(field)) {
      publisherFields.set(field, []);
    }
  }
  const values = $(FIELD_VALUES_SELECTOR)
    .toArray()
    .flatMap((element) => {
      const node = $(element);
      const owner = node.closest(`[${FIELD_ATTRIBUTE}]`).get(0);
      const field =
        owner === undefined ? undefined : $(owner).attr(FIELD_ATTRIBUTE);
      if (field === undefined) {
        return [];
      }
      // Nested styling wrappers for one field represent one occurrence.
      if (
        node
          .parents(FIELD_VALUES_SELECTOR)
          .toArray()
          .some(
            (parent) =>
              $(parent).closest(`[${FIELD_ATTRIBUTE}]`).get(0) === owner,
          )
      ) {
        return [];
      }
      const value = visibleHtmlText(node).trim();
      const references = node
        .find("a[href]")
        .addBack("a[href]")
        .toArray()
        .map((anchor) => {
          const link = $(anchor);
          return {
            text: visibleHtmlText(link).trim(),
            sourceUrl: publisherReferenceUrl(link.attr("href")),
          };
        });
      const prior = publisherFields.get(field);
      const occurrence = prior?.length ?? 0;
      if (prior === undefined) {
        publisherFields.set(field, [value]);
      } else {
        prior.push(value);
      }
      return [{ element, field, occurrence, value, references }];
    });
  const publisherReferences = values.flatMap(
    ({ field, occurrence, references }) =>
      references.map((reference) => ({ field, occurrence, ...reference })),
  );
  const valuesByRow = new Map<AnyNode, typeof values>();
  for (const value of values) {
    const row = $(value.element).closest("tr").get(0);
    if (row === undefined) {
      continue;
    }
    const existing = valuesByRow.get(row);
    if (existing === undefined) {
      valuesByRow.set(row, [value]);
    } else {
      existing.push(value);
    }
  }
  const publisherTables = $("table")
    .toArray()
    .flatMap((table) => {
      const rows = ownTableRows($(table))
        .toArray()
        .flatMap((row) => {
          const rowValues = valuesByRow.get(row);
          if (rowValues === undefined) {
            return [];
          }
          return [
            {
              cells: rowValues.map(({ field, occurrence, value }) => ({
                field,
                occurrence,
                value,
              })),
            },
          ];
        });
      if (rows.length === 0) {
        return [];
      }
      const columns = $(table)
        .find(`thead [${FIELD_ATTRIBUTE}]`)
        .toArray()
        .filter((column) => $(column).closest("table").get(0) === table)
        .flatMap((column) => {
          const field = $(column).attr(FIELD_ATTRIBUTE);
          return field === undefined ? [] : [field];
        });
      return [{ columns, rows }];
    });
  return {
    publisherFields: Object.fromEntries(publisherFields),
    publisherTables,
    publisherReferences,
  };
};
