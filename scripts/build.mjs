import { mkdir, writeFile } from "node:fs/promises";
import { build, context } from "esbuild";

const dev = process.argv.includes("--dev");
const watch = process.argv.includes("--watch");

await mkdir("dist", { recursive: true });

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  // Unminified on purpose: the shipped file stays readable, and `audit:bundle` reads it as text.
  minify: false,
  sourcemap: dev || watch,
  metafile: true,
  logLevel: "info",
};

const writeMetafile = (result) =>
  writeFile("dist/meta.json", `${JSON.stringify(result.metafile, null, 2)}\n`, "utf8");

/**
 * Formats watch diagnostics for VS Code's problem matcher and brackets each rebuild.
 */
const problemMatcherPlugin = {
  name: "problem-matcher",
  setup: (esbuild) => {
    esbuild.onStart(() => console.log("[build] started"));
    esbuild.onEnd((result) => {
      const report =
        (severity) =>
        ({ text, location }) => {
          const where = location
            ? `${location.file}:${location.line}:${location.column}`
            : "unknown:1:1";
          console.log(`${where}: ${severity}: ${text}`);
        };
      result.errors.forEach(report("error"));
      result.warnings.forEach(report("warning"));
      console.log("[build] finished");
    });
  },
};

if (watch) {
  const builder = await context({
    ...options,
    plugins: [
      {
        name: "write-metafile",
        setup: (esbuild) => {
          esbuild.onEnd(async (result) => {
            if (result.metafile) {
              await writeMetafile(result);
            }
          });
        },
      },
      problemMatcherPlugin,
    ],
  });
  await builder.watch();
  console.log("Watching src/ for changes. Reload the Extension Development Host to apply them.");
} else {
  await writeMetafile(await build(options));
}
