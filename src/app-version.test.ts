import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appVersion } from "./app-version.js";
import { renderIndexHtml } from "./web/ui.js";

describe("appVersion", () => {
  it("matches package.json and renders in the web header", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

    expect(appVersion).toBe(packageJson.version);
    expect(renderIndexHtml()).toContain(`v${appVersion}`);
  });
});
