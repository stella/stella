// Passive regression fixture for
// `no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe`.
//
// Every suppression tracks real TypeBox or Elysia provenance, including
// imported aliases, namespace access, computed literal access, and const
// aliases. Removing the custom rule makes these directives unused.

import {
  type TSchema,
  Type,
  Type as TypeAlias,
  Unsafe as unsafeAlias,
} from "@sinclair/typebox";
import * as TypeBox from "@sinclair/typebox";
import { t, t as ElysiaTypes } from "elysia";
import * as Elysia from "elysia";

declare const runtimeSchema: TSchema;

// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- direct TypeBox unsafe schema fixture
Type.Unsafe(runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- aliased TypeBox unsafe schema fixture
TypeAlias.Unsafe(runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- named TypeBox unsafe import fixture
unsafeAlias(runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe, typescript/dot-notation -- computed TypeBox unsafe access fixture
TypeAlias["Unsafe"](runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- TypeBox namespace unsafe schema fixture
TypeBox.Type.Unsafe(runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe, typescript/dot-notation, import/namespace -- computed TypeBox namespace unsafe fixture
TypeBox["Type"]["Unsafe"](runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- Elysia t unsafe schema fixture
t.Unsafe(runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe, typescript/dot-notation -- computed Elysia unsafe access fixture
ElysiaTypes["Unsafe"](runtimeSchema);
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe, typescript/dot-notation, import/namespace -- computed Elysia namespace unsafe fixture
Elysia["t"]["Unsafe"](runtimeSchema);

// oxlint-disable-next-line typescript/unbound-method -- deliberate Type.Unsafe const-alias fixture
const unsafeFromType = Type.Unsafe;
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- const alias of Type.Unsafe fixture
unsafeFromType(runtimeSchema);

const typeboxAlias = Type;
// oxlint-disable-next-line no-unreviewed-typebox-unsafe/no-unreviewed-typebox-unsafe -- const alias of TypeBox namespace fixture
typeboxAlias.Unsafe(runtimeSchema);

const Unsafe = "Unsafe";
TypeAlias[Unsafe](runtimeSchema);

const localSchemaFactory = { Unsafe: (schema: unknown) => schema };
localSchemaFactory.Unsafe(runtimeSchema);

// oxlint-disable-next-line no-shadow -- parameter shadows the TypeBox import to prove source provenance
const shadowedTypebox = (Type: typeof localSchemaFactory) =>
  Type.Unsafe(runtimeSchema);
// oxlint-disable-next-line no-shadow -- parameter shadows the TypeBox Unsafe import to prove source provenance
const shadowedUnsafe = (unsafeAlias: (schema: unknown) => unknown) =>
  unsafeAlias(runtimeSchema);
// oxlint-disable-next-line no-shadow -- parameter shadows the Elysia t import to prove source provenance
const shadowedElysia = (t: typeof localSchemaFactory) =>
  t.Unsafe(runtimeSchema);

export { shadowedElysia, shadowedTypebox, shadowedUnsafe };
