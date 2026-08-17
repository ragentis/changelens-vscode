import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const AUDIT_SCRIPT = path.resolve("scripts/audit-bundle.mjs");
/** The shape the bundle actually has: one call site, taking the arguments its caller prepared. */
const VALID_BUNDLE = `
var childProcess = require("node:child_process");
var execFileAsync = promisify(childProcess.execFile);
execFileAsync("git", args, { cwd: folder });
`;

interface Fixture {
  bundle?: string;
  dependencies?: Record<string, string>;
  inputs?: Record<string, object>;
  imports?: Array<{ path: string; external: boolean }>;
  byteDelta?: number;
}

async function runAudit(fixture: Fixture = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-audit-"));
  const bundle = fixture.bundle ?? VALID_BUNDLE;
  const imports = fixture.imports ?? [{ path: "node:child_process", external: true }];
  const inputs = fixture.inputs ?? { "src/extension.ts": {} };

  try {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "audit-fixture", dependencies: fixture.dependencies ?? {} }),
    );
    await fs.writeFile(path.join(root, "dist", "extension.js"), bundle);
    await fs.writeFile(
      path.join(root, "dist", "meta.json"),
      JSON.stringify({
        inputs,
        outputs: {
          "dist/extension.js": {
            entryPoint: "src/extension.ts",
            imports,
            bytes: Buffer.byteLength(bundle) + (fixture.byteDelta ?? 0),
          },
        },
      }),
    );

    return spawnSync(process.execPath, [AUDIT_SCRIPT], { cwd: root, encoding: "utf8" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("accepts the intended self-contained bundle boundary", async () => {
  const result = await runAudit();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("one Git program without a shell");
});

test.each([
  {
    name: "runtime dependency",
    fixture: { dependencies: { dependency: "1.0.0" } },
    error: "Runtime dependencies are not allowed",
  },
  {
    name: "foreign bundle input",
    fixture: { inputs: { "src/extension.ts": {}, "node_modules/dependency/index.js": {} } },
    error: "Bundle inputs outside src/",
  },
  {
    name: "unexpected external module",
    fixture: { imports: [{ path: "node:https", external: true }] },
    error: "External modules outside the allowlist",
  },
  {
    name: "stale metafile",
    fixture: { byteDelta: 1 },
    error: "does not match the esbuild metafile byte count",
  },
  {
    name: "literal network target",
    fixture: { bundle: `${VALID_BUNDLE}\nconst target = "https://example.com";` },
    error: "Literal network targets are not allowed",
  },
  {
    name: "dynamically assembled fetch target",
    fixture: { bundle: `${VALID_BUNDLE}\nfetch(target);` },
    error: "Network primitive is not allowed: fetch",
  },
  {
    name: "evaluated code",
    fixture: { bundle: `${VALID_BUNDLE}\neval(source);` },
    error: "Forbidden dynamic or shell pattern",
  },
  {
    name: "dynamic require",
    fixture: { bundle: `${VALID_BUNDLE}\nrequire(moduleName);` },
    error: "Forbidden dynamic or shell pattern",
  },
  {
    name: "shell option",
    fixture: { bundle: VALID_BUNDLE.replace("{ cwd: folder }", "{ shell: false }") },
    error: "Forbidden dynamic or shell pattern",
  },
  {
    name: "indexed child process member",
    fixture: { bundle: VALID_BUNDLE.replace("childProcess.execFile", 'childProcess["execFile"]') },
    error: "child_process is reached by index",
  },
  {
    name: "different child process member",
    fixture: { bundle: VALID_BUNDLE.replace("childProcess.execFile", "childProcess.exec") },
    error: "Unexpected child_process access: exec",
  },
  {
    name: "different executable",
    fixture: { bundle: VALID_BUNDLE.replace('"git"', '"powershell"') },
    error: "The only external program must be git",
  },
  {
    name: "arguments built at the call site",
    fixture: { bundle: VALID_BUNDLE.replace("args", '["log", "--format=" + format]') },
    error: "The only external program must be git",
  },
  {
    name: "a second call site",
    fixture: { bundle: `${VALID_BUNDLE}\nexecFileAsync("git", other, { cwd: folder });` },
    error: "The only external program must be git",
  },
])("rejects $name", async ({ fixture, error }) => {
  const result = await runAudit(fixture);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
});
