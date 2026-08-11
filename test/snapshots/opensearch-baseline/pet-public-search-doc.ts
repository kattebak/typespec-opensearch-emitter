export interface PetPublicSearchDoc {
	id: string;
	name: string;
	species: string;
	breed?: string;
	birthDate: string;
	createdAt: string;
	tags: {
		name: string;
		note?: string;
	}[];
	owner: {
		name: string;
	};
	aliases: string[];
	categories: ("Companion" | "Working" | "Exotic")[];
	nickname?: string;
	rank: number;
	stock: number;
	score: number;
	active: boolean;
	approvals: {
		type: string;
		grantedBy: string;
	}[];
	bankAccountApprovals: {
		accountId: string;
		approvedBy: string;
	}[];
}
