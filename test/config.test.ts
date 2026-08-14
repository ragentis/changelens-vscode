import { afterEach, expect, test } from "vitest";
import manifest from "../package.json";
import { DEFAULT_EXCLUDE, excludeGlob, readConfig } from "../src/config";
import * as editor from "./helpers/vscode";

afterEach(() => {
  editor.reset();
});

test("the exclude fallback matches the default contributed in package.json", () => {
  expect(manifest.contributes.configuration.properties["changelens.exclude"].default).toEqual([
    ...DEFAULT_EXCLUDE,
  ]);
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
