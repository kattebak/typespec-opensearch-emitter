# TypeSpec OpenSearch Emitter

TypeSpec emitter that generates OpenSearch artifacts from decorated models:

- **TypeScript interfaces** for search document types
- **OpenSearch mapping JSON** for index creation
- **Barrel `index.ts`** with type exports and index name constants
- **Projection metadata JSON** for tooling integration
- **GraphQL SDL fragments** for AppSync-over-OpenSearch read APIs (opt-in)
- **APPSYNC_JS resolver source** per searchable operation (opt-in)

## Install

```bash
npm install --save-dev @kattebak/typespec-opensearch-emitter @typespec/compiler
```

## Concepts

### `@searchable` and `SearchProjection<T>`

The core workflow:

1. **Annotate source models** — mark fields with `@searchable` to indicate they should be included in search projections.
2. **Create a projection model** — use `model XxxSearchDoc is SearchProjection<SourceModel> {}` to create a search document type. Only `@searchable` fields from the source model are included.
3. **Override decorators in the projection** — redeclare fields in the projection model to add or override `@keyword`, `@analyzer`, `@boost`, or `@nested`.

A field is included in the resolved projection if it carries any of `@searchable`, `@filterable`, or `@aggregatable`. Each role then dictates downstream emission:

- `@searchable` — appears on the SDL response object type, the legacy `<Type>Filter` keyword input, and the OS mapping with text-or-keyword analysis.
- `@filterable` — contributes to the `<Type>SearchFilter` input and `FILTER_SPEC` in the resolver.
- `@aggregatable` — contributes to the aggregations type and the `aggs` block in the resolver.

Filter-only / agg-only fields are mapped as `keyword` directly (no `text`+`keyword` sub-field) since there is no full-text-search surface. Fields with none of the three decorators are excluded from all projections.

### Index name

- Use `@indexName("my_index_v1")` on a projection model to declare the index it is backed by.
- A projection needs both `@searchProjection` and `@indexName` to be emitted top-level: Query field, resolver, mapping, and `graphql-resolvers.json` entry.
- A projection missing either is emitted as a nested type only — a doc type plus a stripped SDL fragment, so a parent projection can reference it as a field type.

## Usage

### TypeSpec example

```typespec
import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Owner {
  @searchable @keyword name: string;
  email: string;
  phone?: string;
}

model Tag {
  @searchable @keyword name: string;
}

model Pet {
  @searchable id: string;
  @searchable name: string;
  @searchable @keyword species: string;
  @searchable breed?: string;
  @searchable birthDate: plainDate;
  @searchable @nested tags: Tag[];
  @searchable owner: Owner;
  internalNotes: string;
}

@indexName("pets_v1")
model PetSearchDoc is SearchProjection<Pet> {
  @analyzer("edge_ngram") @boost(2.0) name: string;
}
```

In this example:

- `Pet.internalNotes` is **excluded** (not `@searchable`).
- `Owner.email` and `Owner.phone` are **excluded** (not `@searchable`).
- `PetSearchDoc` overrides `name` to add a text analyzer and boost.
- `tags` inherits `@nested` from the source model.
- The index name is explicitly set to `pets_v1`.

### `tspconfig.yaml`

```yaml
emit:
  - "@kattebak/typespec-opensearch-emitter"
options:
  "@kattebak/typespec-opensearch-emitter":
    output-file: "opensearch-projections.json"
    emitter-output-dir: "{cwd}/build/opensearch"
```

### Compile

```bash
npx tsp compile . --config tspconfig.yaml
```

## Output

The emitter produces the following files per projection:

```text
build/opensearch/
  index.ts                                  # barrel with type re-exports and index name constants
  opensearch-projections.json               # machine-readable projection metadata
  pet-search-doc.ts                         # TypeScript interface for PetSearchDoc
  pet-search-doc-search-mapping.json        # OpenSearch mapping JSON
```

### `pet-search-doc.ts`

```ts
export interface PetSearchDoc 
{
	id: string;
	name: string;
	species: string;
	breed?: string;
	birthDate: string;
	tags: {
	name: string;
}[];
	owner: {
	name: string;
};
}
```

### `pet-search-doc-search-mapping.json`

```json
{
  "mappings": {
    "properties": {
      "id": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "name": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        },
        "analyzer": "edge_ngram",
        "boost": 2
      },
      "species": { "type": "keyword" },
      "breed": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "birthDate": { "type": "date" },
      "tags": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" }
        }
      },
      "owner": {
        "type": "object",
        "properties": {
          "name": { "type": "keyword" }
        }
      }
    }
  }
}
```

### `index.ts`

```ts
export type { PetSearchDoc } from "./pet-search-doc.js";
export const PET_SEARCH_DOC_INDEX_NAME = "pets_v1";
```

## Nested sub-projections

By default, sub-model collections (e.g. `tags: Tag[]`) include every `@searchable` field of the sub-model. To whitelist specific fields per projection, create a `SearchProjection` for the sub-model and reference it in the parent projection:

```typespec
model Tag {
  @searchable @keyword name: string;
  @searchable createdAt: utcDateTime;
  internalId: string;
}

model TagSearchDoc is SearchProjection<Tag> {}

model Pet {
  @searchable name: string;
  @searchable @nested tags: Tag[];
}

@indexName("pets_v1")
model PetSearchDoc is SearchProjection<Pet> {
  tags: TagSearchDoc[];  // only Tag's @searchable fields via TagSearchDoc
}
```

In this example:

- `TagSearchDoc` resolves only `name` and `createdAt` from `Tag` (both `@searchable`). `internalId` is excluded.
- `PetSearchDoc` references `TagSearchDoc[]` for the `tags` field, so the mapping and TypeScript interface use the sub-projection's fields.
- The `@nested` decorator on the source `tags` field is preserved — the mapping emits `"type": "nested"`.
- The emitted TypeScript interface references `TagSearchDoc[]` (with an import) instead of an inline object type.
- Sub-projection interfaces are automatically emitted and exported from the barrel `index.ts`.

## Spread flattening

Source models sometimes wrap entities in describe-style responses:

```typespec
model Counterparty {
  @searchable @keyword id: string;
  @searchable name: string;
}

model Tag {
  @searchable @keyword name: string;
}

model CounterpartyDescribeResult {
  counterparty: Counterparty;
  tags: Tag[];
}
```

The natural search shape flattens the wrapper so that the counterparty fields live at the top level. Use TypeSpec's `...Model` spread syntax in the projection body to lift `@searchable` fields from another model:

```typespec
model TagSearchDoc is SearchProjection<Tag> {}

model CounterpartySearchDoc is SearchProjection<CounterpartyDescribeResult> {
  ...Counterparty;         // lifts id and name to top level
  tags: TagSearchDoc[];    // sub-projection for tags
}
```

In this example:

- `...Counterparty` inlines `id` and `name` into `CounterpartySearchDoc` (both are `@searchable` on `Counterparty`).
- Non-`@searchable` fields on the spread model are excluded, just like regular source fields.
- Decorators (`@keyword`, `@analyzer`, `@boost`, etc.) on the spread source properties are inherited.
- `@searchAs` works on spread fields for renaming.
- If a spread field name collides with an already-resolved field from the source model, a `spread-field-collision` diagnostic is emitted.

## Decorator reference

| Decorator | Target | Effect | Example |
| --- | --- | --- | --- |
| `@searchable` | `ModelProperty` | Includes a property in projection resolution. | `@searchable name: string;` |
| `@keyword` | `ModelProperty` (string or string[]) | Maps a string field, or an array of strings, as OpenSearch `keyword` instead of `text`. | `@searchable @keyword species: string;` |
| `@nested` | `ModelProperty` (Model[]) | Maps an array-of-model field as OpenSearch `nested` instead of `object`. | `@searchable @nested tags: Tag[];` |
| `@analyzer("name")` | `ModelProperty` (string) | Sets the text analyzer in mapping output. | `@analyzer("edge_ngram") name: string;` |
| `@boost(n)` | `ModelProperty` | Sets field boost factor in mapping output. Must be > 0. | `@boost(2.0) name: string;` |
| `@ignoreAbove(n)` | `ModelProperty` (string) | Overrides `ignore_above` on the keyword sub-field. Must be > 0. | `@ignoreAbove(1024) name: string;` |
| `@indexName("name")` | `Model` (projection) | Declares the index backing the projection. Required for top-level emission; without it the projection is nested-only. | `@indexName("pets_v1") model PetSearchDoc ...` |
| `@indexSettings(json)` | `Model` (projection) | Embeds index settings (e.g. analysis config) in the mapping output. Value must be valid JSON. | See example below. |
| `@searchAs("name")` | `ModelProperty` | Renames the field in mapping and TypeScript output. Can be set on source or projection (projection wins). | `@searchAs("firstName") givenName: string;` |
| `@aggregatable(...kinds)` / `@aggregatable(kind, options)` | `ModelProperty` | Declares OpenSearch aggregations on the GraphQL connection. Allowed kinds: `"terms"`, `"cardinality"`, `"missing"`, `"sum"`, `"avg"`, `"min"`, `"max"`, `"date_histogram"`, `"range"`. Multi-arg form emits all listed string kinds. The single-kind-with-options form is required for `"date_histogram"`, `"range"`, and `"terms"`-with-sub or `"terms"`-with-`topHits`. `topHits: N` adds a `top_hits: { size: N }` sub-agg so each bucket carries up to N matching docs. `"date_histogram"` takes an optional `bounds: #{ min?, max? }` that pins its range and with it the declared interval; without bounds the emitter caps the bucket count instead — see [Bounding a `date_histogram`](#bounding-a-date_histogram). See [Aggregations](#aggregations-aggregatable). | `@aggregatable("terms", "cardinality") locations: Location[];` / `@aggregatable("terms", #{ topHits: 5 }) tagId: string;` / `@aggregatable("date_histogram", #{ interval: "month", bounds: #{ min: "now-5y", max: "now" } }) validTo: utcDateTime;` |
| `@filterable(...kinds)` | `ModelProperty` | Declares filter inputs on the GraphQL `<Type>SearchFilter` input. Allowed kinds: `"term"`, `"term_negate"`, `"terms"`, `"exists"`, `"range"`, `"prefix"`, `"match"`. `"terms"` produces a `<field>In: [Type!]` multi-value input (chip-style filters). On a `@nested` array field, `"exists"` becomes a path-level nested-existence check. `"prefix"` (`<field>Prefix: String`, OpenSearch `prefix`) and `"match"` (`<field>Match: String`, OpenSearch `match`) query the **analyzed** field rather than the `.keyword` sub-field, so an `@analyzer` (e.g. edge-ngram) registered on the field is exercised by the query — this is how partial / begins-with / contains matching is expressed. | `@filterable("term", "terms") status: string;` / `@analyzer("edge_ngram") @filterable("prefix", "match") name: string;` |
| `@searchInfer` | `Model` (projection) | Walks the source model's fields and applies type-driven default `@filterable` / `@aggregatable` / `@sortable` capabilities (see [Inference](#searchinfer-type-driven-defaults)). Explicit decorators on a field always win on their axis. | `@searchInfer model TradeSearchDoc is SearchProjection<Trade> {}` |
| `@searchSkip` | `ModelProperty` | Opts a field out of `@searchInfer` inference. The field is still included in response shape if `@searchable` / `@nested` apply; without those, the field is excluded entirely. | `@searchable @searchSkip auditTrail: string;` |
| `@resolvableBy(Model.key)` / `@resolvableBy(Model.key, "index")` | `Model` | Declares how a row of the model is fetched for a cross-domain join: the key it is read by, and the index that discovers many rows by that key. See [Cross-domain view joins](#cross-domain-view-joins). | `@resolvableBy(OwnershipRecord.petId, "byPetId")` |
| `@dependsOn(Entity, direction, joinKey)` | `Model` (projection) | Declares one joined entity on a projection. `"lookup"` fetches the row while the document is composed; `"inbound"` marks a write on the joined model as a re-index trigger for the driving document. See [Cross-domain view joins](#cross-domain-view-joins). | `@dependsOn(PetPassport, "lookup", Pet.passportId)` |
| `@sortable` | `ModelProperty` | Exposes the field on the projection's `<Type>SortField` enum + `<Type>SortInput` so callers can pass `sortBy: [<Type>SortInput!]`. Inferred for keyword strings, numerics, dates, booleans, enums, and unions when the projection model has `@searchInfer`. Resolver falls back to `_score, _id` when `sortBy` is omitted. | `@sortable @keyword name: string;` |

## `@searchInfer` (type-driven defaults)

Stacking `@filterable` and `@aggregatable` per field becomes noisy on a typical search projection. `@searchInfer` is a model-level decorator that walks the source model's properties and applies a default capability set per type:

| Field type | Default `@filterable` | Default `@aggregatable` | Default `@sortable` |
| --- | --- | --- | --- |
| `utcDateTime` / `offsetDateTime` / `plainDate` | `range` | `date_histogram(month)`, unbounded — see [Bounding a `date_histogram`](#bounding-a-date_histogram) | yes |
| `string` + `@keyword` | `term`, `terms`, `exists` | `terms` | yes |
| free-text `string` (no `@keyword`) | (none) | (none) | no |
| numeric (`int*`, `float*`, `decimal`, …) | `range` | `sum`, `avg`, `min`, `max` | yes |
| `boolean` | `term`, `terms` | (none) | yes |
| `@nested` array field | `exists` (path-level) | (none — sub-projection carries its own `@searchInfer` if desired) | no |
| Enum / scalar union | `term`, `terms`, `exists` | `terms` | yes |
| `bytes` | (none) | (none) | no |

### Nested struct recursion

When a field's type is a TypeSpec model (struct) — either inline (`address: Address`) or as an array (`tags: Tag[]`) — `@searchInfer` recurses into the nested model's properties and applies the same inference table. The parent's `<Type>SearchFilter` exposes `<fieldName>: <NestedType>SearchFilter`, and a separate `<NestedType>SearchFilter` input is emitted alongside.

- **`@nested` array** (OS-nested mapping): filter clauses wrap in `bool.filter[ nested + inner ]`. Free-text search wraps the same way — see [Free-text search across nested fields](#free-text-search-across-nested-fields).
- **Inline struct** (no `@nested`): children carry dotted OS field paths (`address.country`) — no nested wrapper, on either the filter or the free-text axis.
- **Recursion depth**: unbounded; cycles are guarded by a visited-name set.
- **Opt-out**: `@searchSkip` on the parent's field suppresses the virtual sub-projection (and the parent skips the field when no other decorator keeps it in the projection).

### Override semantics

- **No decorators on the field**: gets the inferred set from the table.
- **Explicit `@filterable` on the field**: explicit replaces inferred filterables; agg axis still gets inferred.
- **Explicit `@aggregatable` on the field**: explicit replaces inferred aggregations; filter axis still gets inferred.
- **`@searchSkip` on the field**: emit nothing on either axis. The field stays in response shape if `@searchable` / `@nested` apply; otherwise it's excluded.
- **No `@searchInfer` on the model**: existing rules — a field is included only if it carries `@searchable`, `@filterable`, or `@aggregatable`.

```typespec
model Trade {
  @searchable id: string;
  @keyword counterpartyId: string;
  notional: float64;
  validFrom: utcDateTime;
  active: boolean;
  notes: string;                              // free-text — no inference
  @searchable @searchSkip auditTrail: string; // in response shape, no filters/aggs
}

@searchInfer
model TradeSearchDoc is SearchProjection<Trade> {
  @filterable("term") notional: float64;     // explicit filter, inferred aggs
}
```

In the example above:
- `id` → no inference (free-text string), but stays in the projection because of `@searchable`.
- `counterpartyId` → `term`+`exists` filters and `terms` agg (string + `@keyword`).
- `notional` → explicit `@filterable("term")` replaces inferred `range`; agg axis gets inferred `sum`/`avg`/`min`/`max`.
- `validFrom` → inferred `range` filter and `date_histogram(month)` agg.
- `active` → inferred `term` filter, no agg.
- `notes` → no inference (no `@keyword`).
- `auditTrail` → in response shape, no filters or aggs.

## Type mapping

### TypeScript types (`*-search-doc.ts`)

| TypeSpec type | TypeScript type |
| --- | --- |
| `string`, `plainDate`, `utcDateTime`, `offsetDateTime`, `plainTime`, `duration` | `string` |
| `int32`, `int64`, `float64`, etc. | `number` |
| `boolean` | `boolean` |
| `Model` (object) | inline `{ ... }` (searchable fields only) |
| `T[]` | `T[]` |
| `Record<string, T>` | `Record<string, T>` |

### OpenSearch mappings (`*-search-mapping.json`)

| TypeSpec type | OpenSearch mapping type |
| --- | --- |
| `string` | `text` (with `keyword` sub-field) |
| `string` + `@keyword` | `keyword` |
| `string[]` | `text` (with `keyword` sub-field) |
| `string[]` + `@keyword` | `keyword` |
| `int32`, `int64`, etc. | `long` |
| `float32`, `float64`, etc. | `double` |
| `boolean` | `boolean` |
| `plainDate`, `utcDateTime` | `date` |
| `offsetDateTime` | `date` with `format: strict_date_optional_time` |
| `plainTime`, `duration` | `keyword` |
| `bytes` | `binary` |
| `Model` | `object` (with nested properties) |
| `Model[]` + `@nested` | `nested` (with nested properties) |

`plainTime` and `duration` are keyword rather than `date`: OpenSearch has no
time-of-day or duration type, and `date` anchors both to an instant — it rejects
`PT30M` at index time and pins `09:30:00` to 1970-01-01. Keyword indexes the
ISO 8601 string as written, so `term`/`terms`/`exists` work and a zero-padded
`plainTime` still sorts and ranges chronologically. Duration strings do not
order lexicographically, so range and sort on a `duration` are meaningless.

A type with no entry in this table fails the compile with
`unsupported-scalar-type` or `unsupported-field-type`, naming the field. It used
to emit as `object`, which OpenSearch rejects at index time and which silently
drops every filter, sort and aggregation on the field. A custom scalar maps by
what it extends (`scalar Money extends float64` → `double`), so declare a base
rather than leaving it bare.

## Emitter options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `output-file` | `string` | `opensearch-projections.json` | Filename for the projection metadata JSON. |
| `default-ignore-above` | `number` | `256` | Default `ignore_above` value for keyword sub-fields on text-mapped strings. |
| `package-name` | `string` | — | Package name for emitted `package.json`. Requires `package-version`. |
| `package-version` | `string` | — | Package version for emitted `package.json`. Requires `package-name`. |
| `graphql.emit` | `boolean` | `false` | Enable GraphQL SDL and resolver emission. |
| `graphql.default-page-size` | `number` | `20` | Default page size for connection queries. |
| `graphql.max-page-size` | `number` | `100` | Maximum allowed page size. |
| `graphql.track-total-hits-up-to` | `number` | `10000` | OpenSearch `track_total_hits` limit. |
| `graphql.monolithic-threshold-bytes` | `number` | `32000` | Rendered-resolver size above which the pipeline split is emitted instead of a single file. See [Resolver code-size budget](#resolver-code-size-budget). |
| `graphql.auto-date-histogram-buckets` | `number` | `10000` | Bucket ceiling for a `date_histogram` declared without `bounds`. Decides how wide a range keeps the declared interval before OpenSearch steps to a coarser one. Must stay under `search.max_buckets` (default 65,535). See [Bounding a `date_histogram`](#bounding-a-date_histogram). |

The `emitter-output-dir` option is a standard TypeSpec compiler option that controls the output directory.

## GraphQL emit target (AppSync)

Enable with `graphql.emit: true` to generate GraphQL SDL fragments and APPSYNC_JS resolvers alongside the standard OpenSearch artifacts.

### Configuration

```yaml
emit:
  - "@kattebak/typespec-opensearch-emitter"
options:
  "@kattebak/typespec-opensearch-emitter":
    emitter-output-dir: "{cwd}/build/opensearch"
    graphql:
      emit: true
      default-page-size: 20
      max-page-size: 100
      track-total-hits-up-to: 10000
```

### Generated files

For each projection, the emitter produces:

```text
build/opensearch/
  pet-search-doc.graphql          # GraphQL SDL fragment
  pet-search-doc-resolver.js      # APPSYNC_JS resolver
  graphql-resolvers.json           # manifest mapping projections to files and modules
  resolvers/
    index.ts                       # barrel: specifier → resolver / function source
    pet-search-doc-resolver.ts     # export const code = "<the resolver source>"
  schema/
    index.ts                       # barrel: specifier → SDL text
    pet-search-doc.ts              # export const sdl = "<the SDL fragment>"
```

### GraphQL SDL (`.graphql`)

Each fragment contains:

- **Object type** — derived 1:1 from the search-doc TypeScript interface. Field types map from TypeSpec scalars to GraphQL scalars (`string` → `String`, `int32` → `Int`, `float64` → `Float`, `boolean` → `Boolean`).
- **Filter input** — one optional `String` argument per `@keyword` field for term matching. Omitted if the projection has no keyword fields.
- **Connection envelope** — `*Connection`, `*Edge`, and `PageInfo` types implementing opaque cursor pagination via `search_after`.

Example output for `PetSearchDoc`:

```graphql
type PetSearchDoc {
  id: String!
  name: String!
  species: String!
  breed: String
  birthDate: String!
  tags: [TagSearchDoc!]!
  owner: String!
}

input PetSearchDocFilter {
  species: String
}

type PetSearchDocConnection {
  edges: [PetSearchDocEdge!]!
  totalCount: Int!
  pageInfo: PageInfo!
}

type PetSearchDocEdge {
  node: PetSearchDoc!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}
```

### APPSYNC_JS resolver (`.js`)

Each resolver file exports `request(ctx)` and `response(ctx)` conforming to APPSYNC_JS runtime constraints:

- **No imports** except `@aws-appsync/utils`
- **No network I/O** — resolvers are pure request/response transformers
- `request` builds an OpenSearch `_search` body with:
  - `multi_match` across all `text` fields when `query` argument is provided, plus a `nested`-wrapped `multi_match` per `@nested` sub-model carrying searchable text
  - `term` filters for each `@keyword` field present in the `filter` argument
  - `search_after` cursor pagination (base64-encoded sort values)
  - Deterministic sort: `[_score desc, _id asc]`
- `response` projects hits into the Connection shape with edges, cursors, and pageInfo

#### Documents the schema cannot represent

An indexed document can lack a field the projection declares non-null — a mapping that predates the field, an ingest that half-wrote a sub-document. Returning it would null the field, and non-null propagation turns that into a null `edges` list: one stale document takes the whole page down.

The resolver reconciles what it can (an absent required list becomes `[]`) and omits the documents it cannot, reporting each page's omissions:

- an entry in the GraphQL `errors` block with `errorType: "UnrepresentableDocumentError"`, carrying `errorInfo: { droppedCount, documentIds }` — appended, so the representable rows and the aggregations still reach the caller
- `totalCount` counts only what the API can return, so a short page never looks complete
- a `SearchDocumentDropped` log line carrying the same counts, for a log metric filter to alarm on

`pageInfo.endCursor` marks a position in the index rather than in the response, so a page whose documents were all omitted still advances the cursor.

### Manifest (`graphql-resolvers.json`)

Maps each projection to its resolver, SDL fragment, query field name, and index name. Every artifact is named twice: a `*File` path relative to the emit directory, and a `*Module` import specifier into the package.

```json
{
  "resolvers": [
    {
      "projection": "PetSearchDoc",
      "indexName": "pets_v1",
      "queryFieldName": "searchPet",
      "mode": "pipeline",
      "resolverFile": "pet-search-doc-resolver.js",
      "resolverModule": "resolvers/pet-search-doc-resolver",
      "sdlFile": "pet-search-doc.graphql",
      "sdlModule": "schema/pet-search-doc",
      "functions": [
        {
          "name": "prepare",
          "file": "pet-search-doc-fn-prepare.js",
          "module": "resolvers/pet-search-doc-fn-prepare",
          "dataSource": "NONE"
        }
      ]
    }
  ],
  "nestedTypes": [
    {
      "projection": "TagSearchDoc",
      "sdlFile": "tag-search-doc.graphql",
      "sdlModule": "schema/tag-search-doc"
    }
  ]
}
```

The consuming CDK construct can read this manifest to wire resolvers without hardcoded knowledge.

`nestedTypes` lists the nested-only projections — those without `@searchProjection` or `@indexName`. They have no Query field, resolver, or index, so they carry no `resolvers[]` entry, but top-level fragments reference their types by name. Assemble a schema from `resolvers[].sdlFile` **plus** `nestedTypes[].sdlFile`; using `resolvers[]` alone leaves those references undefined. The key is omitted when a spec has no nested-only projections.

### String modules (`resolvers/`, `schema/`)

Every emitted resolver, pipeline function and SDL fragment also ships as a TypeScript module exporting its source as a string, so a consumer can hand the code to `Code.fromInline` through a type-checked import instead of a path lookup and a file read:

```ts
import { code } from "@scope/pet-search-graphql/resolvers/pet-search-doc-resolver";
import { sdl } from "@scope/pet-search-graphql/schema/pet-search-doc";
```

The manifest's `resolverModule`, `functions[].module` and `sdlModule` are exactly these specifiers, and the generated `package.json` `exports` map declares each one extensionless. The `.js` / `.graphql` files stay in place: a local build directory has no package exports to import through, so a consumer reading artifacts off disk keeps using the `*File` fields.

Reading the manifest is data-driven, though — the resolver a consumer needs is whichever one the manifest names — so a static import per resolver would mean a hand-maintained import list. Two barrels close that: one static import per package, keyed by the same specifier the manifest carries.

```ts
import { resolverCode, pipelineFunctionCode } from "@scope/pet-search-graphql/resolvers";
import { sdl } from "@scope/pet-search-graphql/schema";

for (const entry of manifest.resolvers) {
  new Resolver(scope, entry.queryFieldName, {
    code: Code.fromInline(resolverCode[entry.resolverModule]),
    // ...
  });
}
```

Both barrels are exhaustive over what emission wrote, including every response-walker split file and every nested-type fragment. `test/string-modules.js` asserts that: the barrel keys equal the manifest's specifier set exactly, and each value matches its `.js` / `.graphql` sibling byte for byte.

The generated `tsconfig.json` includes the modules, so the consumer's `prepare` step compiles them along with the doc types.

### Aggregations (`@aggregatable`)

Annotate fields with `@aggregatable(kind, ...)` to expose OpenSearch aggregations on the connection's `aggregations` field. The aggregations run alongside the search query (no separate request).

The decorator has two forms:

- **Multi-arg (string kinds, no options):** `@aggregatable("terms", "cardinality", "missing", "sum", "avg", "min", "max")`. Each listed kind is emitted independently for the same field.
- **Single kind + options (TypeSpec value literal):** `@aggregatable(kind, #{...options})`. Required for `"date_histogram"`, `"range"`, and `"terms"` with sub-aggregations. Use TypeSpec's `#{}` / `#[]` value-literal syntax.

```typespec
model Counterparty {
  @searchable @aggregatable("terms") tags: string[];
  @searchable @aggregatable("terms", "cardinality") locations: string[];
  @searchable @aggregatable("missing") description?: string;
  @searchable @aggregatable("sum", "avg", "min", "max") notional: float64;
}

model Trade {
  @searchable
  @aggregatable("date_histogram", #{ interval: "month" })
  validFrom: utcDateTime;

  @searchable
  @aggregatable("range", #{ ranges: #[
    #{ to: 1000 },
    #{ from: 1000, to: 10000 },
    #{ from: 10000 }
  ]})
  notional: float64;

  @searchable
  @aggregatable("terms", #{ sub: #{
    latestValidTo: #{ kind: "max", field: "validTo" }
  }})
  counterpartyId: string;
}
```

Field-name conventions in the generated `*SearchAggregations` type (singular form for `<Field>`, e.g. `tags` → `byTag`):

| Aggregation kind | Generated field | GraphQL type |
| --- | --- | --- |
| `terms` | `by<Field>` | `[TermBucket!]!` (or `[By<Field>Bucket!]!` if sub-aggs are configured) |
| `cardinality` | `unique<Field>Count` | `Int!` |
| `missing` | `missing<Field>Count` | `Int!` |
| `sum` / `avg` / `min` / `max` | `<field><Sum\|Avg\|Min\|Max>` | `Float` (nullable — OpenSearch returns `null` with no matching docs) |
| `date_histogram` | `by<Field>OverTime` | `[DateHistogramBucket!]!` |
| `range` | `by<Field>Range` | `[RangeBucket!]!` |

A field inside a sub-projection is addressed by its path in the document and named for it: `address.country` aggregates on `address.country` and surfaces as `byAddressCountry`. A `@nested` sub-projection wraps its aggregations in a `nested` aggregation on that path; a plain object sub-projection needs no wrapper.

`date_histogram` requires `interval` (one of `year`, `quarter`, `month`, `week`, `day`, `hour` — defaults to `month` if omitted) and takes an optional `bounds` — see [Bounding a date_histogram](#bounding-a-date_histogram). `range` requires `ranges` (array of `{ from?, to?, key? }`; each entry must set at least one of `from` / `to`). `terms` `sub` allows numeric metric sub-aggregations (`sum`/`avg`/`min`/`max`/`cardinality`) keyed by output bucket field name.

#### Bounding a `date_histogram`

A `date_histogram` covers the full range its data spans. A fixed interval over a wide range therefore has no bucket ceiling: a far-future sentinel date — `validTo = 9999-12-31` for "no end date" is ordinary domain data — puts a monthly histogram at roughly 96,000 buckets. OpenSearch caps a search at `search.max_buckets` (default 65,535) and rejects the whole search when it is exceeded, including the aggregations that had nothing to do with the date field.

A fixed interval over an unbounded range cannot survive, so either the interval or the range has to give. The emitter bends the interval and never the range: narrowing the range would silently drop documents from the answer, while a coarser interval still counts every document and only lowers resolution.

**Declare `bounds` when you need the interval fixed.** The bounds pin the range, so the declared interval is emitted as-is:

```typespec
@searchable
@aggregatable("date_histogram", #{ interval: "month", bounds: #{ min: "2020-01-01T00:00:00Z", max: "now" } })
validTo: utcDateTime;
```

This emits a `date_histogram` with `calendar_interval` and `hard_bounds`. `min` and `max` each accept an ISO 8601 instant or OpenSearch date math (`"now-5y"`); at least one is required, and an omitted end tracks the data. Documents outside the bounds still match the query and count toward `totalCount` — only the buckets stop there.

**Without `bounds`, the emitter caps the bucket count instead.** It emits an `auto_date_histogram` with `minimum_interval` set to your declared interval, so OpenSearch uses that interval whenever the range allows and steps to a coarser one only when it would not fit. Normal data keeps its declared interval; the sentinel case above returns yearly buckets and a chart that renders rather than a failed search. The response reports the interval actually chosen.

The per-histogram ceiling is 10,000 buckets, configurable via [`graphql.auto-date-histogram-buckets`](#emitter-options) — 833 years of monthly buckets, 27 years of daily, 1.1 years of hourly, past any real corpus. `search.max_buckets` counts every bucket in a request, not one aggregation, so a request selecting several histograms divides a soft budget across them: a third of `search.max_buckets` (≈21,845) split by the number of histograms actually selected, capped at the ceiling and floored at 256 so a chart stays legible. Their sum stays under the request limit however many are selected, and the alias fallback that sends every aggregation counts toward the same budget.

**`week` and `quarter` are the exception.** OpenSearch's `minimum_interval` accepts only `year`, `month`, `day`, `hour`, `minute` and `second`, so these two intervals have no automatic ceiling: flooring at `day` or `month` would silently make the chart finer than declared, and `year` would make it coarser. They keep the plain `date_histogram` they have always emitted, and the emitter warns that `bounds` is the only lever available. Declare `bounds` on a `week` or `quarter` histogram whose field may hold a sentinel.

The `.keyword` sub-field is applied automatically when the underlying type is text. Numeric, date, and `@keyword` fields use the bare field name. Filter-only / agg-only fields (no `@searchable`) are mapped as plain keyword in OpenSearch — see [Decorator coverage](#searchable-and-searchprojectiont) for what each decorator contributes.

When no field on a projection is `@aggregatable`, the `aggregations` connection field and aggregation types are omitted (no empty types emitted).

### Conventions

GraphQL intent is derived from the existing OpenSearch mapping — no additional decorators needed:

| OpenSearch mapping | GraphQL behavior |
| --- | --- |
| `@keyword` field | Filterable input argument (term match) |
| `text` field (no `@keyword`) | Included in `multi_match` field list |
| `text` field inside a sub-projection | Included in free-text search — see below |
| All projection fields | Output type fields |
| Sub-projection (`SearchProjection`) | Nested GraphQL type reference |

### Free-text search across nested fields

`@searchable` on a sub-model's `text` field puts that field in free-text search. The `query` argument searches it alongside the root document's fields; no extra decorator opts it in.

How the field is mapped decides the clause:

- **`object` sub-projection** (no `@nested`): the field lives in the root document, so it joins the flat `multi_match` under its dotted path (`owner.fullName`).
- **`@nested` sub-projection**: nested-mapped fields are separate hidden Lucene documents, unreachable by a bare `multi_match` on `tags.note`. Each `@nested` sub-model carrying searchable text contributes one `nested`-wrapped clause, and the clauses combine under `bool.should` with `minimum_should_match: 1`:

```js
bool: {
  should: [
    { multi_match: { query: queryText, fields: ["name"], type: "best_fields" } },
    NQ("tags", ["tags.note"], queryText),
  ],
  minimum_should_match: 1,
}
```

`NQ` is the emitted nested-query helper (`{ nested: { path, score_mode: "max", query: { multi_match: … } } }`). `score_mode: "max"` scores a parent by its best-matching child, so one strong hit ranks a parent the way a root-field hit would.

A projection with no nested searchable text emits the flat `multi_match` alone — no `bool.should`, no helper.

An `@analyzer` on a nested field is honoured: the clause queries the analyzed path, not its `.keyword` sub-field, so edge-ngram partial matching works the same as it does at the root (issue #130).

### Resolver code-size budget

AppSync rejects APPSYNC_JS code above 32,768 bytes per file (`BadRequestException: Code must be 32768 bytes or less`). The cap applies to each file on its own, not to their sum. Issue #99 covered the work to fit inside it.

The emitter renders the single-file shape, measures it, and picks a mode:

| Rendered single-file size | Mode | Emitted files |
| --- | --- | --- |
| ≤ `graphql.monolithic-threshold-bytes` (default `32000`) | `monolithic` | `*-resolver.js` |
| above the threshold | `pipeline` | `*-resolver.js` (after-mapping), `*-fn-prepare.js` (`NONE`), `*-fn-search.js` (`OPENSEARCH`) |

Each pipeline file gets its own 32,768-byte budget. Splitting the work is what makes wide `@searchInfer` projections deployable: the filter and aggregation specs stop competing with the response mapping for one budget.

#### Staying inside the budget

Emitted code stays flat as projections widen by keeping specs as data. A projection emits a compact name → spec map — `FILTER_SPEC` for filter inputs, `AGG_SPEC` for aggregations, both using single-letter keys — plus one assembly function that walks the map at runtime. A new field adds map entries; it does not add code.

Where a literal is unavoidable, the repeated skeleton is factored into a module-level helper called with the varying parts — `ADH` for bounds-less `auto_date_histogram` entries, `NQ` for nested free-text clauses. A nested sub-model then costs ~53 bytes instead of ~153.

Inlining a literal per field instead scales code with projection width. That is what breached the cap twice: issue #101 (counterparty resolver at 38,301 bytes, of which 38,257 were the inline `FILTER_SPEC` literal; fixed by collapsing range-suffix expansions) and issue #105 (37,310 bytes after range-collapse; fixed by factoring repeated nested-doc skeletons).

Emitted code must also stay in the APPSYNC_JS supported subset. `src/emit-graphql-resolver.test.ts` runs `@aws-appsync/eslint-plugin` over the output.

#### Guards

Three tests in `src/emit-graphql-resolver.test.ts` assert every emitted file stays under 32,768 bytes. Measured after the per-request bucket budget (issue #155):

| Projection | Resolver | Prepare | Search | Headroom |
| --- | --- | --- | --- | --- |
| counterparty shape (7 nested sub-models) | 8,991 | 24,754 | 742 | 8,014 |
| counterparty shape, 2 searchable text fields per sub-model | 8,491 | 24,617 | 742 | 8,151 |
| synthetic wide (14 sub-models) | 14,458 | 32,452 | 732 | **316** |

`prepare` is the constrained file in all three, and headroom depends on projection width. The 14-sub-model guard governs: at 316 bytes, the next change touching the prepare function hits the cap. Real projections are not close — the counterparty shape renders 18,319 bytes as a single file and stays monolithic.

Nested free-text search (issue #158) costs ~53 bytes per `@nested` sub-model carrying searchable text (it scales with path length), plus 166 bytes once for the `NQ` helper. It is charged only to projections that have such a field. The 14-sub-model guard is the shape where that matters: its sub-models are all `@keyword`/date, so it pays nothing, but adding searchable text to every sub-model of a projection that wide would exceed the cap — as the 316-byte headroom already implies for any addition.

CI goes red on the guard, and AppSync refuses the deploy. The assertion message prints the current headroom — trust it over these numbers.

#### When a guard goes red

The message names the file and its size. Work in this order:

1. **Check whether the growth is per-field.** Code that repeats once per field or per sub-model belongs in a spec entry, not in the emitted body. This is the fix for #101 and #105 and the first thing to try.
2. **Check the mode.** A monolithic projection tipping past the threshold falls back to the pipeline split on its own. A pipeline file over the cap has no further automatic split.
3. **Fall back to spec-as-data-asset.** Loading `FILTER_SPEC` from a data source instead of inlining it removes the size bound entirely, at the cost of one indirection. This is lever 3 from #101 and is not implemented.

Do not raise the constant in the assertion. 32,768 is an AWS limit, not a project policy — a green test with a raised cap fails at deploy instead.

## Cross-domain view joins

`SearchProjection<T>` resolves fields from one source model, so a field owned by another spec cannot enter the document and no manifest key says a write over there should re-index anything here. `@resolvableBy` and `@dependsOn` declare that join.

A pet care view wants three things in one index: the pet, its passport (a separate spec, joined by `passportId`), and its ownership history (records that reference the pet as `petId`).

```typespec
@resolvableBy(PetPassport.passportId)
model PetPassport {
  passportId: string;
  @searchable @keyword microchipId: string;
  @searchable @keyword @filterable("term") @aggregatable("terms") issuedCountry: string;
  @searchable @keyword vaccinations: string[];
}

@resolvableBy(OwnershipRecord.petId, "byPetId")
model OwnershipRecord {
  ownershipRecordId: string;
  petId: string;
  @searchable @keyword @filterable("term") ownerName: string;
  @searchable @filterable("range") transferredAt: utcDateTime;
}

@searchProjection
@indexName("pet_care_v1")
@dependsOn(PetPassport, "lookup", Pet.passportId)
@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
model PetCareSearchDoc is SearchProjection<Pet> {
  passport?: PetPassportSearchDoc;
  @nested ownershipHistory: OwnershipRecordSearchDoc[];
}
```

`@resolvableBy` states how a row of the model is fetched: the key it is read by, and — second argument — the index that discovers every row carrying that key.

`@dependsOn` states one joined entity on a projection. `lookup` fetches the row while the document is composed. `inbound` marks the joined model as an invalidation trigger: a write there re-indexes the driving entity's document.

Both joins are left joins. Waffles the beagle has a passport; Nugget, a stray, does not, so `passport` is absent on his document and `ownershipHistory` is `[]`. Rehoming Waffles writes an `OwnershipRecord` and re-indexes his document.

### Field binding

A declaration says where the joined value lands, not only that it exists. Each `@dependsOn` binds to **exactly one** projection field — the one typed as the entity or as its search document. A `lookup` fills a single-valued field, an `inbound` fills an array. That binding is what names the resolver method and what `dependencies[].field` carries.

A field typed as the entity itself, rather than as its search document, composes from that model's `@searchable` properties — or from the whole model when it carries `@searchInfer`. A model offering neither has nothing to contribute and reports `join-field-not-composed`.

### What a bound field composes into

The bound field is an ordinary field of the document from there on. It lands in the emitted document type, the index mapping and the GraphQL SDL, mapped `nested` where the projection declares `@nested`:

```ts
export interface PetCareSearchDoc {
	petId: string;
	name: string;
	species: string;
	passportId: string;
	passport?: PetPassportSearchDoc;
	ownershipHistory: OwnershipRecordSearchDoc[];
}
```

```json
"passport": { "type": "object", "properties": { "microchipId": { "type": "keyword" } } },
"ownershipHistory": { "type": "nested", "properties": { "ownerName": { "type": "keyword" } } }
```

Both joins are left joins, so an absent passport leaves the field absent and a pet with no records carries `[]`.

### Filtering and faceting a joined field

A joined field filters, sorts and aggregates like any other field of its type: the joined document's own `@filterable`, `@aggregatable` and `@sortable` declarations reach the parent's `SearchFilter`, sort enum and aggregations, addressed by their path in the composed document.

```graphql
input PetCareSearchFilter {
  passport: PetPassportSearchFilter
  ownershipHistory: OwnershipRecordSearchFilter
}

type PetCareSearchAggregations {
  byPassportIssuedCountry: [TermBucket!]!
}
```

This is the point of composing at index time: one query facets over fields several domains own, with exact counts.

### The read a join runs against

`@resolvableBy` binds to the `@restResolver` GET operation that returns the model **and takes its declared key as a path or query parameter**. A sibling `listX()` over the same model is not that read — nothing hands it the key — so only the designated one carries a `resolvableBy` block.

### Manifest blocks

The read operation's `graphql-resolvers.json` entry carries a `resolvableBy` block:

```json
{
  "typeName": "Query",
  "fieldName": "listOwnershipRecords",
  "resourcePath": "/ownership-records",
  "resolvableBy": {
    "entity": "OwnershipRecord",
    "key": "petId",
    "index": "byPetId"
  }
}
```

The projection's `opensearch-projections.json` entry carries `dependencies[]`, one object per declaration:

```json
{
  "name": "PetCareSearchDoc",
  "indexName": "pet_care_v1",
  "dependencies": [
    {
      "entity": "PetPassport",
      "direction": "lookup",
      "joinKey": "passportId",
      "field": "passport"
    },
    {
      "entity": "OwnershipRecord",
      "direction": "inbound",
      "joinKey": "petId",
      "field": "ownershipHistory",
      "index": "byPetId"
    }
  ]
}
```

`index` appears on an `inbound` entry only: a lookup fetches the row its key names, so the discovery index has nothing to say about it.

Both blocks ship a JSON schema, exported from the package as `./schema/resolvable-by.schema.json` and `./schema/dependencies.schema.json`. Each key is omitted when nothing declares it, so a spec with no joins emits an unchanged manifest.

### Join resolver (`*-join-resolver.ts`)

A projection with dependencies gets a TypeScript interface for the reads its declarations imply — one method per declaration, named for the field it fills, taking the join key and returning that field's declared type:

```ts
export interface PetCareSearchDocJoinResolver {
	lookupPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;
	discoverOwnershipHistory(petId: string): Promise<OwnershipRecordSearchDoc[]>;
}
```

A `lookup` returns one row or nothing; a discovery returns however many rows the index holds. Naming the method after the field keeps two joins over the same entity apart, since a model cannot declare a property twice.

### Implementing a join resolver

The interface is the whole contract. The emitter names the methods and types them; the implementation supplies the bodies, and nothing about it is prescribed — a REST client, a database read, a cache, an in-memory map all satisfy the same interface.

**A `lookup` returns the one row its key names, or `undefined`.** The argument is the value the driving row carries in the declared join key. `undefined` means the reference resolves to nothing, and the field is absent from the composed document.

**A discovery returns every row referencing the driving entity, or `[]`.** The argument is the driving entity's key value. Order is not significant — a `@nested` array is queried per row, not by position. No rows is `[]`, never `undefined`.

**Return the document shape, not the source entity.** The return type is the field's declared type, so only the fields the mapping declares are carried. Anything else is written into the index unmapped.

**A read that fails, fails the compose.** Never return `undefined` or `[]` to stand in for an error: both are valid answers, so a swallowed failure writes a document that is silently wrong and stays wrong until the next write to the driving entity.

For the pet care view, with reads the caller supplies:

```ts
import type {
	OwnershipRecordSearchDoc,
	PetCareSearchDocJoinResolver,
	PetPassportSearchDoc,
} from "./generated/index.js";

interface PetCareReads {
	petPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;
	ownershipRecords(petId: string): Promise<OwnershipRecordSearchDoc[]>;
}

export function petCareJoinResolver(
	reads: PetCareReads,
): PetCareSearchDocJoinResolver {
	return {
		lookupPassport: (passportId) => reads.petPassport(passportId),
		discoverOwnershipHistory: (petId) => reads.ownershipRecords(petId),
	};
}
```

Composing one document is then a function of the driving row:

```ts
const passport = await resolver.lookupPassport(pet.passportId);
const ownershipHistory = await resolver.discoverOwnershipHistory(pet.petId);

const document: PetCareSearchDoc = {
	...pet,
	...(passport ? { passport } : {}),
	ownershipHistory,
};
```

#### What re-indexes a document

A composed document is a snapshot: it is only as fresh as the last compose, and a query never reads through to the joined domain. Keeping it current is the writer's job, and `dependencies[]` states which writes matter.

| Write | Re-index |
| --- | --- |
| The driving entity | Its own document |
| An entity reached by `lookup` | Every document whose join key names it |
| An entity reached by `inbound` | The document its join key names |

An `inbound` declaration is what makes a write in the joined domain a trigger at all, which is why it requires a `@resolvableBy` index: discovering affected documents is a query by the join key, not a fetch. Recompose the whole document rather than patching the changed field — the compose is a pure function of the driving row's id, so a replay or a reordered trigger converges on the same document.

### Diagnostics

| Code | Severity | Fires when |
| --- | --- | --- |
| `unknown-join-key` | error | A key path names a property the model does not own, inheritance included — `@resolvableBy` takes a key on its own model, a `lookup` takes a key on the projection's source model, an `inbound` takes a key on the joined entity. |
| `join-index-required` | error | An `inbound` join names an entity whose `@resolvableBy` declares no index, so nothing can discover the rows. |
| `undeclared-join-resolution` | error | A `@dependsOn` names a model carrying no `@resolvableBy`, so nothing states how a row of it is fetched. |
| `invalid-join-direction` | error | A direction other than `lookup` or `inbound`. |
| `join-requires-projection` | error | `@dependsOn` sits on a model that is not a `SearchProjection<T>`. |
| `join-field-missing` | error | No projection field is typed to receive the declared entity. |
| `join-field-ambiguous` | error | More than one field could receive it, so nothing decides which. |
| `join-field-arity` | error | A `lookup` bound to an array field, or an `inbound` bound to a single-valued one. |
| `join-field-not-composed` | error | The bound field names a model that states nothing about what enters the document — no `SearchProjection<T>`, no `@searchInfer`, no `@searchable` property — so composing it would emit an empty object. |
| `join-read-operation-missing` | warning | No `@restResolver` GET returns the entity and takes its declared key, so the join has nothing to call. |


## Index settings (analyzers, tokenizers, filters)

Use `@indexSettings` to embed analysis configuration in the mapping output. The value is a JSON string that will be emitted as the `settings` block:

```typespec
@indexName("pets_v1")
@indexSettings("""
{
  "analysis": {
    "analyzer": {
      "edge_ngram_autocomplete": {
        "type": "custom",
        "tokenizer": "edge_ngram_tokenizer",
        "filter": ["lowercase"]
      }
    },
    "tokenizer": {
      "edge_ngram_tokenizer": {
        "type": "edge_ngram",
        "min_gram": 2,
        "max_gram": 10,
        "token_chars": ["letter", "digit"]
      }
    }
  }
}
""")
model PetSearchDoc is SearchProjection<Pet> {
  @analyzer("edge_ngram_autocomplete") @boost(2.0) name: string;
}
```

This produces a mapping file with both `settings` and `mappings`:

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "edge_ngram_autocomplete": {
          "type": "custom",
          "tokenizer": "edge_ngram_tokenizer",
          "filter": ["lowercase"]
        }
      },
      "tokenizer": {
        "edge_ngram_tokenizer": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 10,
          "token_chars": ["letter", "digit"]
        }
      }
    }
  },
  "mappings": {
    "properties": { ... }
  }
}
```

When `@indexSettings` is not used, only `mappings` is emitted (backwards compatible).

## Contributing

```bash
npm install
npm run build
npm run lint
npm test          # runs build + lint + unit tests + emit test + example test
```

### Test structure

- `src/**/*.test.ts` — unit tests (decorators, projection resolution, emitters)
- `test/main.tsp` — integration fixture compiled by `npm run test:emit`
- `test/example.js` — validates emitted output files against expectations
- `test/pet-care/main.tsp` — cross-domain join fixture compiled by `npm run test:emit:joins`; `test/pet-care-example.js` validates the emitted blocks against the published JSON schemas
- `test/string-modules.js` — validates the `resolvers/` and `schema/` string modules, their `exports` subpaths and the barrels against the manifest

## License

See [LICENSE](./LICENSE).
