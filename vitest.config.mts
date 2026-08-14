import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The project directory with the Windows drive letter forced to upper case, which is how Vite
 * spells the paths it resolves itself. A lower-case one reaches the alias below whenever the glob
 * has to be rescanned, and the fake — along with the runner reached through it — is then loaded a
 * second time under a path that compares unequal, leaving every file with no runner registered.
 * No-op away from Windows, where the pattern cannot match.
 */
const projectRoot = path
  .resolve(fileURLToPath(new URL(".", import.meta.url)))
  .replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    alias: {
      // The extension host is not available under vitest, so `import * as vscode` resolves to a
      // fake backed by a real temp directory. See test/helpers/vscode.ts.
      vscode: path.join(projectRoot, "test", "helpers", "vscode.ts"),
    },
  },
});
