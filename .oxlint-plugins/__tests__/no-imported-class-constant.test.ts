import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-imported-class-constant", () => {
  test("reports opaque class constants on UI components", async () => {
    expect(
      await lintSingleRule(
        "no-imported-class-constant",
        'import { Button } from "@stll/ui";\nimport { classes } from "./styles";\nconst view = <Button className={classes} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([3]);
  });
  test("reports constants composed with inline classes", async () => {
    expect(
      await lintSingleRule(
        "no-imported-class-constant",
        'import { Button as Action } from "@stll/ui/button";\nimport { classes } from "./styles";\nconst view = <Action className={cn("mt-2", classes)} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([3]);
  });
  test("accepts local class values", async () => {
    expect(
      await lintSingleRule(
        "no-imported-class-constant",
        'import { Button } from "@stll/ui";\nconst classes = "mt-2";\nconst view = <Button className={classes} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("accepts icon and neighboring package components", async () => {
    expect(
      await lintSingleRule(
        "no-imported-class-constant",
        'import { Icon } from "@stll/ui/icons";\nimport { Button } from "@stll/ui-kit/button";\nimport { classes } from "./styles";\nconst view = <><Icon className={classes} /><Button className={classes} /></>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("accepts shadowing class parameters and intrinsic elements", async () => {
    expect(
      await lintSingleRule(
        "no-imported-class-constant",
        'import { Button } from "@stll/ui";\nimport { classes } from "./styles";\nfunction render(classes) { return <Button className={classes} />; }\nconst view = <div className={classes} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
