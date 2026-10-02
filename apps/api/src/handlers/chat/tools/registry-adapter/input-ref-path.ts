import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * The path grammar of an `InputRefParam`, shared by the three directions that
 * read it (dehydration, persistence, replay) so they cannot disagree on where
 * a tool's input refs sit.
 *
 * A path is dot-separated keys; a key suffixed `[]` addresses every element of
 * the array it holds. `matter_id` is one top-level value;
 * `positions[].sources[]` is every string in every position's `sources`. This
 * is the grammar the output projection reports its ref paths in.
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
 * `location` names one concrete leaf (`positions[0].sources[1]`), which is
 * what tells two leaves of one path apart. For a top-level path it is the
 * path itself.
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
 * A copy of `input` with every leaf the path addresses replaced by
 * `mapLeaf`'s answer. A leaf is visited whatever its type, and only when its
 * key is present; an absent key, or a container of the wrong shape on the
 * way, addresses nothing. Nothing off the path is touched.
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
