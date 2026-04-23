# TypeSpec OpenSearch Emitter

A TypeSpec emitter for generating OpenSearch projection metadata.

## Status

Scaffolded emitter skeleton with CI, linting, tests, and TypeSpec emitter wiring.

## Usage

```typespec
import "@kattebak/typespec-opensearch-emitter";
```

```yaml
emit:
  - "@kattebak/typespec-opensearch-emitter"
options:
  "@kattebak/typespec-opensearch-emitter":
    output-file: "opensearch-projections.json"
```
