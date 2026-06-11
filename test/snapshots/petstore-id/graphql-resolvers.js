import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(
  readFileSync(join(packageDir, "graphql-resolvers.json"), "utf-8")
);
export default manifest;
