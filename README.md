# TypeSpec OpenSearch Emitter

A TypeSpec emitter for generating OpenSearch projection metadata.

## Status

Implemented so far:

- Decorator infrastructure via TypeSpec library state
- Decorators: `@searchable`, `@keyword`, `@nested`, `@analyzer`, `@boost`, `@indexName`
- Decorator validation diagnostics
- `SearchProjection<T>` template + projection resolution
- Emitter collection of projection models and resolved projection metadata output
- CI, linting, unit tests, emitter E2E test

## Usage

```typespec
import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Product {
  @searchable id: string;
  @searchable @keyword title: string;
  internalNotes: string;
}

@indexName("products_v1")
model ProductSearchDoc is SearchProjection<Product> {
  @analyzer("edge_ngram") title: string;
}
```

```yaml
emit:
  - "@kattebak/typespec-opensearch-emitter"
options:
  "@kattebak/typespec-opensearch-emitter":
    output-file: "opensearch-projections.json"
```

Current emitted file is projection metadata JSON and is an intermediate step toward document type and mapping emitters.
