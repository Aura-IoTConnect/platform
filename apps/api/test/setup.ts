import { existsSync } from "node:fs";

// Tests hit the real dev Postgres (already migrated/seeded) rather than
// mocking Prisma — this repo has no separate test DB yet.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
