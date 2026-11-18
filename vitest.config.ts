import { defineConfig } from "vitest/config";

// Restrict discovery to the project's own suites. Without this, the default
// glob also collects unrelated checkouts under `.scratch/` and `node_modules`,
// burying the real result. `npm run test:release` narrows this further with its
// `tests/integration` positional filter.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "client/__tests__/**/*.test.{ts,tsx}"],
  },
});
