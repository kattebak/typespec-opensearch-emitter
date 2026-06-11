import type { TagSearchDoc } from "./tag-search-doc.js";
import type { ApprovalSearchDoc } from "./approval-search-doc.js";

export interface PetSearchDoc {
	id: string;
	name: string;
	species: string;
	breed?: string;
	birthDate: string;
	createdAt: string;
	tags: TagSearchDoc[];
	owner: {
		name: string;
	};
	aliases: string[];
	nickname?: string;
	rank: number;
	stock: number;
	score: number;
	active: boolean;
	approvals: ApprovalSearchDoc[];
}
