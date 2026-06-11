import type { Address } from "./address.js";

export interface PersonSearchDoc {
	id: string;
	address?: Address;
}
