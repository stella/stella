import { describe, expect, test } from "bun:test";

// Every shared toast surface must expose the full provider reason. Enumerating
// the actual JSX catches new floating/anchored variants without a mirror list.
const truncatingToastSurfaces = (source: string) =>
  [...source.matchAll(/<Toast\.(?:Title|Description|Content)\b[^>]*>/gu)]
    .map((match) => match[0])
    .filter((surface) =>
      /\b(?:truncate|text-ellipsis|line-clamp-\d+|whitespace-nowrap|overflow-hidden)\b/u.test(
        surface,
      ),
    );

describe("full toast error text", () => {
  test("every floating and anchored toast surface allows full text", async () => {
    const source = await Bun.file(new URL("toast.tsx", import.meta.url)).text();
    const surfaces = [
      ...source.matchAll(/<Toast\.(Title|Description|Content)\b/gu),
    ];
    expect(surfaces.length).toBeGreaterThan(0);
    expect(new Set(surfaces.map((match) => match[1]))).toEqual(
      new Set(["Title", "Description", "Content"]),
    );
    expect(truncatingToastSurfaces(source)).toEqual([]);
  });

  test("the census rejects a planted truncating error toast", () => {
    const planted = `<Toast.Root toast={{ type: "error" }}>
      <Toast.Content><Toast.Title className="truncate font-medium" /></Toast.Content>
    </Toast.Root>`;
    expect(truncatingToastSurfaces(planted)).toEqual([
      '<Toast.Title className="truncate font-medium" />',
    ]);
  });

  test.each([
    "line-clamp-2",
    "whitespace-nowrap",
    "overflow-hidden",
    "text-ellipsis",
  ])("the census rejects %s on an error surface", (className) => {
    expect(
      truncatingToastSurfaces(`<Toast.Description className="${className}" />`),
    ).toHaveLength(1);
  });
});
