import { afterEach, expect, test } from "vitest";
import manifest from "../package.json";
import { DEFAULT_EXCLUDE, excludeGlob, readConfig } from "../src/config";
import { BASE_SCHEME, REVIEW_SCHEME } from "../src/ui/schemes";
import * as editor from "./helpers/vscode";

afterEach(() => {
  editor.reset();
});

test("the exclude fallback matches the default contributed in package.json", () => {
  expect(manifest.contributes.configuration.properties["changelens.exclude"].default).toEqual([
    ...DEFAULT_EXCLUDE,
  ]);
});

test("every scheme that opens on its own is labelled as a ChangeLens view", () => {
  const labelled = manifest.contributes.resourceLabelFormatters
    .map((formatter) => formatter.scheme)
    .sort();

  // These two open as plain tabs, where nothing else distinguishes them from the real file: the
  // path is the same and only the name is shown. The current side is only ever a diff pane.
  expect(labelled).toEqual([BASE_SCHEME, REVIEW_SCHEME].sort());
  for (const formatter of manifest.contributes.resourceLabelFormatters) {
    expect(formatter.formatting.label).toContain("ChangeLens");
  }
});

test("a limit of zero or less falls back instead of tracking nothing", () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0);
  editor.state.configuration.set("changelens.maxTrackedFiles", -1);

  const config = readConfig();
  expect(config.maxFileSizeKb).toBe(512);
  expect(config.maxTrackedFiles).toBe(20000);
});

test("a single exclude pattern is used as-is and several are joined into one brace group", () => {
  expect(excludeGlob([])).toBeUndefined();
  expect(excludeGlob(["**/node_modules/**"])).toBe("**/node_modules/**");
  expect(excludeGlob(["**/node_modules/**", "**/dist/**"])).toBe("{**/node_modules/**,**/dist/**}");
});
