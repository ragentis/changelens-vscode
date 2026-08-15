import { expect, test } from "vitest";
import manifest from "../package.json";
import { REVIEW_SCHEMES } from "../src/ui/schemes";

test("every review file system activates the extension before access", () => {
  const activationEvents = new Set(manifest.activationEvents);

  for (const scheme of REVIEW_SCHEMES) {
    expect(activationEvents.has(`onFileSystem:${scheme}`)).toBe(true);
  }
});
