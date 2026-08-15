import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import manifest from "../package.json";
import { MIRRORS } from "../src/ui/reviewLanguage";
import { must } from "./helpers/assert";

/**
 * A mirror that is missing from the manifest fails silently: `setTextDocumentLanguage` rejects, the
 * retag swallows it, and the review keeps the errors it was meant to lose. So the map and the
 * manifest are held to each other here rather than by hand.
 */

const root = path.join(__dirname, "..");
const targets = [...MIRRORS.values()];

function languageFor(target: string) {
  return must(
    manifest.contributes.languages.find((entry) => entry.id === target),
    `a language contribution for ${target}`,
  );
}

function scopeNameIn(file: string): unknown {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return typeof parsed === "object" && parsed !== null && "scopeName" in parsed
    ? parsed.scopeName
    : undefined;
}

test("every mirror has a language contribution", () => {
  const declared = new Set(manifest.contributes.languages.map((language) => language.id));
  expect(targets.filter((target) => !declared.has(target))).toEqual([]);
});

test("every mirror has a grammar whose file matches its scope", () => {
  for (const target of targets) {
    const grammar = must(
      manifest.contributes.grammars.find((entry) => entry.language === target),
      `a grammar contribution for ${target}`,
    );
    const file = path.join(root, grammar.path);
    expect(fs.existsSync(file), `${grammar.path} is missing`).toBe(true);
    expect(scopeNameIn(file)).toBe(grammar.scopeName);
  }
});

test("every mirror points at a language configuration that exists", () => {
  for (const target of targets) {
    const { configuration } = languageFor(target);
    expect(fs.existsSync(path.join(root, configuration)), `${configuration} is missing`).toBe(true);
  }
});

/**
 * The one property that keeps a mirror off real files: with nothing to match a path against, the
 * editor can never assign it on its own, so only the retag can reach it.
 */
test("no mirror language claims a path of its own", () => {
  const claims = new Set(["extensions", "filenames", "filenamePatterns"]);
  for (const target of targets) {
    expect(Object.keys(languageFor(target)).filter((key) => claims.has(key))).toEqual([]);
  }
});
