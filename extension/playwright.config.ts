import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 150_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
