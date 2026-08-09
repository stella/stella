# Canonical resource identity

Stella represents a linkable product object as a discriminated `ResourceRef`:

```ts
{ type: "entity", id: SafeId<"entity"> }
```

The type is a stable product noun; the ID is opaque. Domain payloads, database
tables, and presentation labels remain specialized. For example, documents,
folders, tasks, and legal-list items can all refer to the same underlying
`entity` identity without becoming one domain model.

`toResourceName` serializes a ref as a route-independent name such as
`stella://resource/entity/<id>`. Resource names are durable identifiers, not UI
URLs, access grants, or share capabilities.

## Separate concerns

- Authorization remains in the owning domain. A ref identifies the target; it
  never proves access.
- Route context stays separate. An entity chat link carries an entity ref plus
  a workspace location because identity alone does not determine its UI route.
- Revisions remain separate resources where they have their own lifecycle.
- Relationships are not promoted to resources merely because their join table
  has an ID.
- Each cross-domain consumer has a total disposition map. Adding a resource
  type therefore requires explicit URL, mention, search, MCP, authorization,
  and backlink decisions, including explicit unsupported decisions.

Legacy search IDs and chat metadata remain compatibility envelopes. Producers
derive their canonical refs from the same branded IDs. Readers that accept both
forms reject conflicting dual representations, preventing silent drift during
rolling deployments.

## Design references

This design is a clean-room synthesis of public patterns; it does not translate
or copy an implementation:

- [Backstage entity references](https://backstage.io/docs/features/software-catalog/references/): complete canonical references between systems; contextual defaults only while parsing.
- [Apollo Client cache normalization](https://www.apollographql.com/docs/react/caching/overview): type plus ID as normalized identity, with explicit per-type policy.
- [Kubernetes object names and UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/): locator, immutable identity, and resource revision are distinct concepts.
- [OpenFGA modeling principles](https://openfga.dev/docs/best-practices/modeling-design-principles): authorization models the domain instead of treating an object identifier as access proof.
- [Google AIP-122 resource names](https://google.aip.dev/122): stable resource names are compatibility contracts, independent of API endpoints.
- [Rails GlobalID](https://www.rubydoc.info/gems/globalid): typed global locators, allowlisted lookup, and signed capabilities as separate layers.
- [Macro entity model](https://github.com/macro-inc/macro/blob/a4e252587d24773b0393220045bc6e7abef4cb9c/crates/model-entity/src/lib.rs): a small cross-domain entity identity powering heterogeneous features while payloads remain domain-owned.
