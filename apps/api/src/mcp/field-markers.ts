import { panic } from "better-result";

const FIELD_MARKER_PREFIX = "[[[__stella_mcp_anonymized_field_";
const FIELD_MARKER_SUFFIX = "__]]]";
const MAX_MARKER_NAMESPACE_ATTEMPTS = 4;

const getFieldMarker = ({
  index,
  markerNamespace,
}: {
  index: number;
  markerNamespace: string;
}) => `${FIELD_MARKER_PREFIX}${markerNamespace}_${index}${FIELD_MARKER_SUFFIX}`;

export const buildFieldMarkers = ({
  fieldCount,
  fields,
  randomUUID = () => Bun.randomUUIDv7(),
}: {
  fieldCount: number;
  fields: string[];
  randomUUID?: () => string;
}) => {
  for (let attempt = 0; attempt < MAX_MARKER_NAMESPACE_ATTEMPTS; attempt += 1) {
    const markerNamespace = randomUUID();
    const markers = Array.from({ length: fieldCount }, (_, index) =>
      getFieldMarker({
        index,
        markerNamespace,
      }),
    );
    const hasCollision = markers.some((marker) =>
      fields.some((field) => field.includes(marker)),
    );

    if (!hasCollision) {
      return markers;
    }
  }

  return panic("Unable to generate collision-free anonymized field markers");
};
