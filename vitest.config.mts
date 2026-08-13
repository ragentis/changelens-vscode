import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    alias: {
      // The extension host is not available under vitest, so `import * as vscode` resolves to a
      // fake backed by a real temp directory. See test/helpers/vscode.ts.
      vscode: fileURLToPath(new URL("./test/helpers/vscode.ts", import.meta.url)),
    },
  },
});
