import { defineConfig } from "vitest/config";
// VOBIZ_NO_BROWSER=1: commands that would open a browser (docs open, login --browser) must print the URL instead.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", env: { VOBIZ_NO_BROWSER: "1" } } });
