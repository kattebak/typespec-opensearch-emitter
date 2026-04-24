# TypeSpec OpenSearch Emitter

TypeSpec emitter that generates OpenSearch artifacts from decorated models:

- **TypeScript interfaces** for search document types
- **OpenSearch mapping JSON** for index creation
- **Barrel `index.ts`** with type exports and index name constants
- **Projection metadata JSON** for tooling integration

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

Fields **not** marked `@searchable` on the source model are excluded from all projections.

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

## Decorator reference

| Decorator | Target | Effect | Example |
| --- | --- | --- | --- |
| `@searchable` | `ModelProperty` | Includes a property in projection resolution. | `@searchable name: string;` |
| `@keyword` | `ModelProperty` (string) | Maps a string field as OpenSearch `keyword` instead of `text`. | `@searchable @keyword species: string;` |
| `@nested` | `ModelProperty` (Model[]) | Maps an array-of-model field as OpenSearch `nested` instead of `object`. | `@searchable @nested tags: Tag[];` |
| `@analyzer("name")` | `ModelProperty` (string) | Sets the text analyzer in mapping output. | `@analyzer("edge_ngram") name: string;` |
| `@boost(n)` | `ModelProperty` | Sets field boost factor in mapping output. Must be > 0. | `@boost(2.0) name: string;` |
| `@indexName("name")` | `Model` (projection) | Sets an explicit index name for the projection. | `@indexName("pets_v1") model PetSearchDoc ...` |
| `@indexSettings(json)` | `Model` (projection) | Embeds index settings (e.g. analysis config) in the mapping output. Value must be valid JSON. | See example below. |

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

The `emitter-output-dir` option is a standard TypeSpec compiler option that controls the output directory.

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
