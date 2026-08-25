import "@typespec/http";
import "@kattebak/typespec-opensearch-emitter";

using TypeSpec.Http;
using Kattebak.OpenSearch;

model Pet {
	@searchable @keyword petId: string;
	@searchable @keyword name: string;
	@searchable @keyword species: string;
	@searchable @keyword passportId: string;
}

@resolvableBy(PetPassport.passportId)
model PetPassport {
	passportId: string;

	@searchable @keyword microchipId: string;

	@searchable
	@keyword
	@filterable("term")
	@aggregatable("terms")
	issuedCountry: string;

	@searchable @keyword vaccinations: string[];
}

@resolvableBy(OwnershipRecord.petId, "byPetId")
model OwnershipRecord {
	ownershipRecordId: string;
	petId: string;

	@searchable @keyword @filterable("term") @aggregatable("terms") ownerName: string;
	@searchable @filterable("range") transferredAt: utcDateTime;
}

model PetPassportSearchDoc is SearchProjection<PetPassport> {}

model OwnershipRecordSearchDoc is SearchProjection<OwnershipRecord> {}

@searchProjection
@indexName("pet_care_v1")
@dependsOn(PetPassport, "lookup", Pet.passportId)
@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
model PetCareSearchDoc is SearchProjection<Pet> {
	passport?: PetPassportSearchDoc;

	@nested ownershipHistory: OwnershipRecordSearchDoc[];
}

@route("/pet-passports")
namespace PetPassports {
	@restResolver @get op getPetPassport(@path passportId: string): PetPassport;

	// Returns the same entity, but nothing hands it the join key, so it is not
	// the read the join runs against and carries no resolvableBy block.
	@restResolver @get op listPetPassports(@query issuedCountry?: string): PetPassport[];
}

@route("/ownership-records")
namespace OwnershipRecords {
	@restResolver
	@get
	op listOwnershipRecords(@query petId: string): OwnershipRecord[];
}
