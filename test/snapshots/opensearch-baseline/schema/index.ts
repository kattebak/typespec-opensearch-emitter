import { sdl as approvalSearchDoc } from "./approval-search-doc.js";
import { sdl as bankAccountApprovalSearchDoc } from "./bank-account-approval-search-doc.js";
import { sdl as personSearchDoc } from "./person-search-doc.js";
import { sdl as petPublicSearchDoc } from "./pet-public-search-doc.js";
import { sdl as petSearchDoc } from "./pet-search-doc.js";
import { sdl as tagSearchDoc } from "./tag-search-doc.js";

export const sdl: Record<string, string> = {
	"schema/approval-search-doc": approvalSearchDoc,
	"schema/bank-account-approval-search-doc": bankAccountApprovalSearchDoc,
	"schema/person-search-doc": personSearchDoc,
	"schema/pet-public-search-doc": petPublicSearchDoc,
	"schema/pet-search-doc": petSearchDoc,
	"schema/tag-search-doc": tagSearchDoc,
};
