/**
 * Pure helpers that turn a chat tool call's input into readable key/value
 * rows, for every surface that asks a person to approve the call: the web's
 * approval card and the phone's. Kept free of any UI so both read a call the
 * same way.
 */

export type ReadableInputRow = {
  key: string;
  label: string;
  value: string;
};

/** Longer string values are truncated in the approval summary. */
const MAX_VALUE_CHARS = 200;

export const humanizeIdentifier = (value: string): string =>
  value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/^\p{L}/u, (match) => match.toLocaleUpperCase());

/** A value cut to the length an approval summary shows. */
export const truncateReadableValue = (value: string): string =>
  value.length > MAX_VALUE_CHARS
    ? `${value.slice(0, MAX_VALUE_CHARS)}…`
    : value;

export const formatReadableInputValue = ({
  emptyLabel,
  value,
}: {
  emptyLabel: string;
  value: unknown;
}): string => {
  if (value === null || value === undefined) {
    return emptyLabel;
  }

  if (typeof value === "string") {
    return truncateReadableValue(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return truncateReadableValue(
      value
        .map((child) => formatReadableInputValue({ emptyLabel, value: child }))
        .join(", "),
    );
  }

  const parts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    parts.push(
      `${humanizeIdentifier(key)}: ${formatReadableInputValue({
        emptyLabel,
        value: child,
      })}`,
    );
  }
  return truncateReadableValue(parts.join("; "));
};

export const getReadableInputRows = ({
  emptyLabel,
  input,
  requestLabel,
}: {
  emptyLabel: string;
  input: unknown;
  requestLabel: string;
}): ReadableInputRow[] => {
  if (input === undefined || input === null || typeof input !== "object") {
    return [
      {
        key: "request",
        label: requestLabel,
        value: formatReadableInputValue({ emptyLabel, value: input }),
      },
    ];
  }

  if (Array.isArray(input)) {
    return input.map((value, index) => ({
      key: String(index),
      label: String(index + 1),
      value: formatReadableInputValue({ emptyLabel, value }),
    }));
  }

  const rows: ReadableInputRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }

  return rows;
};

/**
 * Approval rows for a credential-backed connector operation. These values
 * are the exact payload sent after approval, so the review surface must not
 * shorten a nested argument or omit a suffix the connector will receive.
 */
export const getCompleteConnectorInputRows = ({
  emptyLabel,
  input,
  requestLabel,
}: {
  emptyLabel: string;
  input: unknown;
  requestLabel: string;
}): ReadableInputRow[] => {
  if (input === undefined || input === null) {
    return [
      {
        key: "request",
        label: requestLabel,
        value: emptyLabel,
      },
    ];
  }
  if (typeof input !== "object") {
    const value =
      typeof input === "string" ||
      typeof input === "number" ||
      typeof input === "boolean" ||
      typeof input === "bigint"
        ? String(input)
        : emptyLabel;
    return [
      {
        key: "request",
        label: requestLabel,
        value,
      },
    ];
  }

  return Object.entries(input).map(([key, value]) => {
    let readableValue: string;
    if (value === undefined || value === null) {
      readableValue = emptyLabel;
    } else if (typeof value === "object") {
      readableValue = JSON.stringify(value, null, 2);
    } else {
      readableValue = String(value);
    }
    return {
      key,
      label: humanizeIdentifier(key),
      value: readableValue,
    };
  });
};
