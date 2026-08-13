import "@typespec/http";
import "@kattebak/typespec-opensearch-emitter";

using TypeSpec.Http;
using Kattebak.OpenSearch;

model Pet {
	petId: string;
	name: string;
	status: PetStatus;
	createdAt: int64;
}

enum PetStatus {
	Available,
	Pending,
	Sold,
}

model CreatePetInput {
	name: string;
	status: PetStatus;
	createdAt: int64;
}

@route("/pets")
namespace Pets {
	@restResolver @get op getPet(@path petId: string): Pet;
	@restResolver @post op createPet(@body input: CreatePetInput): Pet;
	@restResolver @get op listPets(@query status?: string): Pet[];

	@restResolver
	@route("/search")
	@get
	op searchPets(
		@query(#{ explode: true }) status?: PetStatus[],
		@query(#{ explode: true }) name?: string,
	): Pet[];
}
