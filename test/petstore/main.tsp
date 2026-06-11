import "@typespec/http";
import "@kattebak/typespec-opensearch-emitter";

using TypeSpec.Http;
using Kattebak.OpenSearch;

model Pet {
	petId: string;
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
	@restResolver @get op getPet(@path petId: string): Pet;
	@restResolver @post op createPet(@body input: CreatePetInput): Pet;
	@restResolver @get op listPets(@query status?: string): Pet[];
}
