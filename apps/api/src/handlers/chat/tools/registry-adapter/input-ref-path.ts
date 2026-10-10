import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * The path syntax of an `InputRefParam`. Dehydration, persistence, and replay
 * all read paths through this module, so they cannot disagree on where a
 * tool's input refs are.
 *
 * A path is a list of keys separated by dots. A key ending in `[]` means
 * "every element of this array". So `matter_id` is one top-level value, and
 * `positions[].sources[]` is every item in every position's `sources`. The
 * output projection reports its ref paths in the same syntax.
 */

type PathSegment = { key: string; each: boolean };

const ARRAY_SUFFIX = "[]";

const parseInputRefPath = (path: string): PathSegment[] =>
  path
    .split(".")
    .map((part) =>
      part.endsWith(ARRAY_SUFFIX)
        ? { key: part.slice(0, -ARRAY_SUFFIX.length), each: true }
        : { key: part, each: false },
    );

/**
 * `location` is the path of one concrete value, with array indexes filled in
 * (`positions[0].sources[1]`), so two values matched by the same path can be
 * told apart. For a top-level path it equals the path.
 */
type MapInputRefLeaf = (value: unknown, location: string) => unknown;

type MapSegmentsArgs = {
  container: Record<string, unknown>;
  segments: readonly PathSegment[];
  parentLocation: string;
  mapLeaf: MapInputRefLeaf;
};

const mapSegments = ({
  container,
  segments,
  parentLocation,
  mapLeaf,
}: MapSegmentsArgs): Record<string, unknown> => {
  const [segment, ...rest] = segments;
  if (segment === undefined || !(segment.key in container)) {
    return container;
  }
  const location =
    parentLocation === "" ? segment.key : `${parentLocation}.${segment.key}`;
  const mapValue = (value: unknown, valueLocation: string): unknown => {
    if (rest.length === 0) {
      return mapLeaf(value, valueLocation);
    }
    return isRecord(value)
      ? mapSegments({
          container: value,
          segments: rest,
          parentLocation: valueLocation,
          mapLeaf,
        })
      : value;
  };

  const value = container[segment.key];
  if (!segment.each) {
    return { ...container, [segment.key]: mapValue(value, location) };
  }
  if (!isUnknownArray(value)) {
    return container;
  }
  return {
    ...container,
    [segment.key]: value.map((item, index) =>
      mapValue(item, `${location}[${index}]`),
    ),
  };
};

type MapInputRefLeavesArgs = {
  input: Record<string, unknown>;
  path: string;
  mapLeaf: MapInputRefLeaf;
};

/**
 * Returns a copy of `input` in which every value the path points to is
 * replaced by the result of `mapLeaf`. `mapLeaf` is called for a value of any
 * type, but only when its key is present. If a key is missing, or a value
 * along the path is not the object or array the path expects, nothing is
 * mapped. Values outside the path are left unchanged.
 */
export const mapInputRefLeaves = ({
  input,
  path,
  mapLeaf,
}: MapInputRefLeavesArgs): Record<string, unknown> =>
  mapSegments({
    container: input,
    segments: parseInputRefPath(path),
    parentLocation: "",
    mapLeaf,
  });
