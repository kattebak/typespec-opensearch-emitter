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

### Index name derivation

- Use `@indexName("my_index_v1")` on a projection model to set an explicit index name.
- If omitted, the index name is derived from the model name by converting PascalCase to snake_case (e.g. `PetSearchDoc` → `pet_search_doc`).

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
| `@keyword` | `ModelProperty` (string) | Maps a string field as OpenSearch `keyword` instead of `text`. | `@searchable @keyword species: string;` |
| `@nested` | `ModelProperty` (Model[]) | Maps an array-of-model field as OpenSearch `nested` instead of `object`. | `@searchable @nested tags: Tag[];` |
| `@analyzer("name")` | `ModelProperty` (string) | Sets the text analyzer in mapping output. | `@analyzer("edge_ngram") name: string;` |
| `@boost(n)` | `ModelProperty` | Sets field boost factor in mapping output. Must be > 0. | `@boost(2.0) name: string;` |
| `@ignoreAbove(n)` | `ModelProperty` (string) | Overrides `ignore_above` on the keyword sub-field. Must be > 0. | `@ignoreAbove(1024) name: string;` |
| `@indexName("name")` | `Model` (projection) | Sets an explicit index name for the projection. | `@indexName("pets_v1") model PetSearchDoc ...` |
| `@indexSettings(json)` | `Model` (projection) | Embeds index settings (e.g. analysis config) in the mapping output. Value must be valid JSON. | See example below. |
| `@searchAs("name")` | `ModelProperty` | Renames the field in mapping and TypeScript output. Can be set on source or projection (projection wins). | `@searchAs("firstName") givenName: string;` |
| `@aggregatable(...kinds)` | `ModelProperty` | Declares OpenSearch aggregations to expose on the GraphQL connection. Allowed kinds: `"terms"`, `"cardinality"`, `"missing"`, `"sum"`, `"avg"`, `"min"`, `"max"`. Multi-arg emits all listed kinds. Numeric metric kinds (`sum`/`avg`/`min`/`max`) emit a nullable `Float` field on the aggregations type — OpenSearch returns `null` when no documents match. | `@aggregatable("terms", "cardinality") locations: Location[];` / `@aggregatable("sum", "avg") notional: float64;` |
| `@filterable(...kinds)` | `ModelProperty` | Declares filter inputs on the GraphQL `<Type>SearchFilter` input. Allowed kinds: `"term"`, `"term_negate"`, `"exists"`, `"range"`. On a `@nested` array field, `"exists"` becomes a path-level nested-existence check (`true` matches docs with at least one nested element; `false` matches docs with none). | `@filterable("term", "term_negate") status: string;` / `@filterable("exists") @nested tags: Tag[];` |

## Type mapping

### TypeScript types (`*-search-doc.ts`)

| TypeSpec type | TypeScript type |
| --- | --- |
| `string`, `plainDate`, `utcDateTime` | `string` |
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
| `int32`, `int64`, etc. | `long` |
| `float32`, `float64`, etc. | `double` |
| `boolean` | `boolean` |
| `plainDate`, `utcDateTime` | `date` |
| `Model` | `object` (with nested properties) |
| `Model[]` + `@nested` | `nested` (with nested properties) |

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
  graphql-resolvers.json           # manifest mapping projections to files
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
  - `multi_match` across all `text` fields when `query` argument is provided
  - `term` filters for each `@keyword` field present in the `filter` argument
  - `search_after` cursor pagination (base64-encoded sort values)
  - Deterministic sort: `[_score desc, _id asc]`
- `response` projects hits into the Connection shape with edges, cursors, and pageInfo

### Manifest (`graphql-resolvers.json`)

Maps each projection to its resolver file, SDL file, query field name, and index name:

```json
{
  "resolvers": [
    {
      "projection": "PetSearchDoc",
      "indexName": "pets_v1",
      "queryFieldName": "searchPet",
      "resolverFile": "pet-search-doc-resolver.js",
      "sdlFile": "pet-search-doc.graphql"
    }
  ]
}
```

The consuming CDK construct can read this manifest to wire resolvers without hardcoded knowledge.

### Aggregations (`@aggregatable`)

Annotate fields with `@aggregatable("terms" | "cardinality" | "missing", ...)` to expose OpenSearch aggregations on the connection's `aggregations` field. The aggregations run alongside the search query (no separate request).

```typespec
model Counterparty {
  @searchable @aggregatable("terms") tags: string[];
  @searchable @aggregatable("terms", "cardinality") locations: string[];
  @searchable @aggregatable("missing") description?: string;
}
```

Field-name conventions in the generated `*SearchAggregations` type (singular `<Field>`, e.g. `tags` -> `byTag`):

| Aggregation kind | Generated field | GraphQL type |
| --- | --- | --- |
| `terms` | `by<Field>` | `[TermBucket!]!` |
| `cardinality` | `unique<Field>Count` | `Int!` |
| `missing` | `missing<Field>Count` | `Int!` |

The `.keyword` sub-field is applied automatically when the underlying type is text. Numeric, date, and `@keyword` fields use the bare field name.

When no field on a projection is `@aggregatable`, the `aggregations` connection field and aggregation types are omitted (no empty types emitted).

### Conventions

GraphQL intent is derived from the existing OpenSearch mapping — no additional decorators needed:

| OpenSearch mapping | GraphQL behavior |
| --- | --- |
| `@keyword` field | Filterable input argument (term match) |
| `text` field (no `@keyword`) | Included in `multi_match` field list |
| All projection fields | Output type fields |
| Sub-projection (`SearchProjection`) | Nested GraphQL type reference |

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

## License

See [LICENSE](./LICENSE).
