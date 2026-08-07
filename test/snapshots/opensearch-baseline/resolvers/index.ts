import { code as personSearchDocFnPrepare } from "./person-search-doc-fn-prepare.js";
import { code as personSearchDocFnSearch } from "./person-search-doc-fn-search.js";
import { code as personSearchDocResolver } from "./person-search-doc-resolver.js";
import { code as petPublicSearchDocFnPrepare } from "./pet-public-search-doc-fn-prepare.js";
import { code as petPublicSearchDocFnSearch } from "./pet-public-search-doc-fn-search.js";
import { code as petPublicSearchDocResolver } from "./pet-public-search-doc-resolver.js";
import { code as petSearchDocFnPrepare } from "./pet-search-doc-fn-prepare.js";
import { code as petSearchDocFnSearch } from "./pet-search-doc-fn-search.js";
import { code as petSearchDocResolver } from "./pet-search-doc-resolver.js";
import { code as tagSearchDocFnPrepare } from "./tag-search-doc-fn-prepare.js";
import { code as tagSearchDocFnSearch } from "./tag-search-doc-fn-search.js";
import { code as tagSearchDocResolver } from "./tag-search-doc-resolver.js";

export const resolverCode: Record<string, string> = {
	"resolvers/person-search-doc-resolver": personSearchDocResolver,
	"resolvers/pet-public-search-doc-resolver": petPublicSearchDocResolver,
	"resolvers/pet-search-doc-resolver": petSearchDocResolver,
	"resolvers/tag-search-doc-resolver": tagSearchDocResolver,
};
export const pipelineFunctionCode: Record<string, string> = {
	"resolvers/person-search-doc-fn-prepare": personSearchDocFnPrepare,
	"resolvers/person-search-doc-fn-search": personSearchDocFnSearch,
	"resolvers/pet-public-search-doc-fn-prepare": petPublicSearchDocFnPrepare,
	"resolvers/pet-public-search-doc-fn-search": petPublicSearchDocFnSearch,
	"resolvers/pet-search-doc-fn-prepare": petSearchDocFnPrepare,
	"resolvers/pet-search-doc-fn-search": petSearchDocFnSearch,
	"resolvers/tag-search-doc-fn-prepare": tagSearchDocFnPrepare,
	"resolvers/tag-search-doc-fn-search": tagSearchDocFnSearch,
};
