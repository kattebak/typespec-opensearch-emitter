import "../dist/index.js";

using TypeSpec.Reflection;

namespace Kattebak.OpenSearch;

extern dec searchable(target: ModelProperty);
extern dec keyword(target: ModelProperty);
extern dec nested(target: ModelProperty);
extern dec analyzer(target: ModelProperty, name: valueof string);
extern dec boost(target: ModelProperty, factor: valueof float64);
extern dec ignoreAbove(target: ModelProperty, limit: valueof uint32);
extern dec indexName(target: Model, name: valueof string);
extern dec indexSettings(target: Model, settings: valueof string);
extern dec searchAs(target: ModelProperty, name: valueof string);
extern dec aggregatable(target: ModelProperty, ...args: valueof unknown[]);
extern dec filterable(target: ModelProperty, ...kinds: valueof string[]);
extern dec searchInfer(target: Model);
extern dec searchSkip(target: ModelProperty);
extern dec sortable(target: ModelProperty);

model SearchProjection<T> {}
