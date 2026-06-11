import "@typespec/http";
import "@kattebak/typespec-opensearch-emitter";

using TypeSpec.Http;
using Kattebak.OpenSearch;

// Issue #136 — the petstore example with the opt-in @graphqlId marker.
// Identical to test/petstore/main.tsp except for the decorations; key-like
// string fields surface as GraphQL ID instead of String. Resolver codegen
// must be unaffected (same util.urlEncode interpolation).
model Pet {
	@graphqlId petId: string;
	name: string;
	status: PetStatus;
}

enum PetStatus {
	Available,
	Pending,
	Sold,
}

model CreatePetInput {
	name: string;
	status: PetStatus;
}

@route("/pets")
namespace Pets {
	@restResolver @get op getPet(@path @graphqlId petId: string): Pet;
	@restResolver @post op createPet(@body input: CreatePetInput): Pet;
	@restResolver @get op listPets(@query status?: string): Pet[];
}
