import { cpSync } from "node:fs";

cpSync("src/public", "dist/public", { recursive: true });
