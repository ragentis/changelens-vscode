import { readFile } from "node:fs/promises";

// Machine-check the shipped-code claims that are easy to regress: only project-owned inputs, no
// runtime dependencies or network access, and one fixed Git command without a shell. Filesystem
// writes are intentionally allowed because baseline persistence and revert are core behavior.

const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail("Runtime dependencies are not allowed");
}

const metafile = JSON.parse(await readFile("dist/meta.json", "utf8"));
const inputs = Object.keys(metafile.inputs);
const foreignInputs = inputs.filter((input) => {
  const normalized = normalize(input);
  return !normalized.startsWith("src/") || normalized.split("/").includes("..");
});
if (foreignInputs.length > 0) {
  fail(`Bundle inputs outside src/: ${foreignInputs.join(", ")}`);
}

const outputEntry = Object.entries(metafile.outputs).find(
  ([output]) => normalize(output) === "dist/extension.js",
);
if (!outputEntry) {
  fail("dist/extension.js is missing from the esbuild metafile");
}

const [, output] = outputEntry;
if (normalize(output.entryPoint ?? "") !== "src/extension.ts") {
  fail(`Unexpected bundle entry point: ${output.entryPoint ?? "(missing)"}`);
}

const internalImports = output.imports.filter((entry) => !entry.external);
if (internalImports.length > 0) {
  fail(`Bundle is not self-contained: ${internalImports.map((entry) => entry.path).join(", ")}`);
}

const ALLOWED_EXTERNALS = new Set([
  "vscode",
  "node:child_process",
  "node:crypto",
  "node:fs/promises",
  "node:path",
  "node:util",
  "node:zlib",
]);
const externalImports = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
const unexpectedExternals = [...new Set(externalImports)].filter(
  (specifier) => !ALLOWED_EXTERNALS.has(specifier),
);
if (unexpectedExternals.length > 0) {
  fail(`External modules outside the allowlist: ${unexpectedExternals.join(", ")}`);
}

const bundle = await readFile("dist/extension.js", "utf8");
if (output.bytes !== Buffer.byteLength(bundle)) {
  fail("dist/extension.js does not match the esbuild metafile byte count");
}

// Node network modules are excluded above. These checks close the remaining literal and global-API
// routes while acknowledging that this is shipped-text inspection, not whole-program analysis.
const urls = [...new Set(bundle.match(/https?:\/\/[^\s"'`\\]+/g) ?? [])];
if (urls.length > 0) {
  fail(`Literal network targets are not allowed: ${urls.join(", ")}`);
}
for (const primitive of ["fetch", "WebSocket", "EventSource"]) {
  if (new RegExp(String.raw`\b${primitive}\b`).test(bundle)) {
    fail(`Network primitive is not allowed: ${primitive}`);
  }
}

const forbiddenPatterns = [
  /\beval\s*\(/,
  /\b(?:new\s+)?Function\s*\(/,
  /\brequire\s*\(\s*[^"'`]/,
  /\bimport\s*\(\s*[^"'`]/,
  /\bshell\s*:/,
];
for (const pattern of forbiddenPatterns) {
  if (pattern.test(bundle)) {
    fail(`Forbidden dynamic or shell pattern in the bundle: ${pattern}`);
  }
}

// The only process boundary is the fixed Git query documented in SECURITY.md. Following the
// bundler binding prevents another child_process member from hiding behind the allowed module.
const childProcessRequire = /require\("node:child_process"\)/;
const childProcessBindings = [
  ...bundle.matchAll(
    new RegExp(
      String.raw`(?:var|let|const)\s+([\w$]+)\s*=\s*[\w$]*\(?${childProcessRequire.source}`,
      "g",
    ),
  ),
].map((match) => match[1]);
if (childProcessBindings.length !== 1) {
  fail("The audit cannot identify exactly one child_process binding");
}

const [childProcessBinding] = childProcessBindings;
if (new RegExp(String.raw`\b${childProcessBinding}\s*\[`).test(bundle)) {
  fail("child_process is reached by index, which hides the member from this audit");
}

const childProcessMembers = [
  ...bundle.matchAll(new RegExp(String.raw`\b${childProcessBinding}\.([\w$]+)`, "g")),
].map((match) => match[1]);
if (childProcessMembers.length !== 1 || childProcessMembers[0] !== "execFile") {
  fail(`Unexpected child_process access: ${childProcessMembers.join(", ") || "(none)"}`);
}

const gitCalls = bundle.match(/\bexecFileAsync\s*\(/g) ?? [];
const expectedGitCall =
  /\bexecFileAsync\s*\(\s*"git"\s*,\s*\[\s*"rev-parse"\s*,\s*"--git-path"\s*,\s*"HEAD"\s*\]\s*,/;
if (gitCalls.length !== 1 || !expectedGitCall.test(bundle)) {
  fail("The only external command must be git rev-parse --git-path HEAD");
}

console.log(
  [
    `Bundle audit passed: ${inputs.length} source inputs,`,
    `${new Set(externalImports).size} allowed external modules,`,
    "no runtime dependencies or network access,",
    "one fixed Git command without a shell.",
  ].join(" "),
);

function normalize(filePath) {
  return filePath.replaceAll("\\", "/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
