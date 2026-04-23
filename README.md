# TypeSpec OpenSearch Emitter

TypeSpec emitter for generating OpenSearch projection artifacts from decorated models.

## Install

```bash
npm install --save-dev @kattebak/typespec-opensearch-emitter @typespec/compiler
```

## Usage

### TypeSpec example

```typespec
import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Owner {
  @searchable @keyword name: string;
  email: string;
  phone: string;
}

model Tag {
  @searchable @keyword name: string;
}

model Pet {
  @key id: string;
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
npx tsp compile test/main.tsp --config test/tspconfig.yaml
```

## Decorator reference

| Decorator | Target | Effect | Example |
| --- | --- | --- | --- |
| `@searchable` | `ModelProperty` | Includes a property in projection resolution. | `@searchable name: string;` |
| `@keyword` | `ModelProperty` (string) | Maps a string field as OpenSearch `keyword`. | `@searchable @keyword species: string;` |
| `@nested` | `ModelProperty` (`Model[]`) | Maps an array-of-model field as OpenSearch `nested`. | `@searchable @nested tags: Tag[];` |
| `@analyzer("name")` | `ModelProperty` (string) | Sets text analyzer in mapping output. | `@analyzer("edge_ngram") name: string;` |
| `@boost(2.0)` | `ModelProperty` | Sets field boost in mapping output. | `@boost(2.0) name: string;` |
| `@indexName("name")` | `Model` (projection) | Overrides derived index name for projection output. | `@indexName("pets_v1") model PetSearchDoc ...` |

## Emitter options

Defined in `src/lib.ts`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `output-file` | `string` | `opensearch-projections.json` | File name for projection metadata JSON output. |

## Output structure

Current output files per projection:

```text
build/opensearch/
  index.ts
  opensearch-projections.json
  <projection>-search-doc.ts
  <projection>-search-mapping.json
```

Real output example from `test/main.tsp`:

### `build/opensearch/product-search-doc.ts`

```ts
export interface ProductSearchDoc 
{
	id: string;
	title: string;
}
```

### `build/opensearch/product-search-doc-search-mapping.json`

```json
{
  "mappings": {
    "properties": {
      "id": {
        "type": "text",
        "fields": {
          "keyword": {
            "type": "keyword",
            "ignore_above": 256
          }
        }
      },
      "title": {
        "type": "keyword"
      }
    }
  }
}
```

### `build/opensearch/index.ts`

```ts
export type { ProductSearchDoc } from "./product-search-doc.js";
export const PRODUCT_SEARCH_DOC_INDEX_NAME = "products_v1";
```

## Contributing

```bash
npm run fix
npm run lint
npm test
```
