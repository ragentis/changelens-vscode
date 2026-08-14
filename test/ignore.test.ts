import { expect, test } from "vitest";
import { IgnoreMatcher } from "../src/tracking/ignore";

/** ChangeLens folds exclude matching only on Windows, so a case-distinct macOS path stays visible. */
const foldsCase = process.platform === "win32";

function excluding(...patterns: string[]): IgnoreMatcher {
  const matcher = new IgnoreMatcher();
  matcher.add(patterns);
  return matcher;
}

function gitignoring(...lines: string[]): IgnoreMatcher {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore(lines.join("\n"));
  return matcher;
}

// #region wildcards

test("a bare name matches at any depth, and an anchored one only at the root", () => {
  const loose = excluding("notes.bak");
  expect(loose.ignores("notes.bak")).toBe(true);
  expect(loose.ignores("src/deep/notes.bak")).toBe(true);

  const anchored = excluding("/notes.bak");
  expect(anchored.ignores("notes.bak")).toBe(true);
  expect(anchored.ignores("src/notes.bak")).toBe(false);
});

test("a single star stops at the separator and a double star crosses it", () => {
  const single = excluding("src/*.ts");
  expect(single.ignores("src/a.ts")).toBe(true);
  expect(single.ignores("src/deep/a.ts")).toBe(false);

  const double = excluding("src/**/*.ts");
  expect(double.ignores("src/a.ts")).toBe(true);
  expect(double.ignores("src/deep/a.ts")).toBe(true);
});

test("a name without wildcards also covers everything beneath it", () => {
  const matcher = excluding("vendor");
  expect(matcher.ignores("vendor")).toBe(true);
  expect(matcher.ignores("vendor/deep/a.ts")).toBe(true);
  expect(matcher.ignores("vendored.ts")).toBe(false);
});

test("a question mark matches one character within a segment", () => {
  const matcher = excluding("a?.ts");
  expect(matcher.ignores("ab.ts")).toBe(true);
  expect(matcher.ignores("a.ts")).toBe(false);
  expect(matcher.ignores("a/.ts")).toBe(false);
});

// #endregion

// #region brace groups and character classes

test("a brace group matches each of its alternatives", () => {
  const matcher = excluding("**/{dist,build}/**");
  expect(matcher.ignores("dist/a.js")).toBe(true);
  expect(matcher.ignores("build/a.js")).toBe(true);
  expect(matcher.ignores("packages/web/dist/a.js")).toBe(true);
  expect(matcher.ignores("src/a.js")).toBe(false);
});

test("a brace group nests and combines with wildcards", () => {
  const matcher = excluding("src/{a,b{1,2}}.*");
  expect(matcher.ignores("src/a.ts")).toBe(true);
  expect(matcher.ignores("src/b1.ts")).toBe(true);
  expect(matcher.ignores("src/b2.js")).toBe(true);
  expect(matcher.ignores("src/b3.ts")).toBe(false);
});

test("a git pattern takes braces literally, the way git does", () => {
  const matcher = gitignoring("{dist,build}/a.js");
  expect(matcher.ignores("{dist,build}/a.js")).toBe(true);
  expect(matcher.ignores("dist/a.js")).toBe(false);
});

test("a character class matches a set and a range", () => {
  const matcher = gitignoring("log[0-9].txt", "tmp[abc]");
  expect(matcher.ignores("log7.txt")).toBe(true);
  expect(matcher.ignores("logx.txt")).toBe(false);
  expect(matcher.ignores("tmpb")).toBe(true);
  expect(matcher.ignores("tmpd")).toBe(false);
});

test("a negated character class excludes its set without escaping the segment", () => {
  const matcher = gitignoring("src/[!x]*.ts");
  expect(matcher.ignores("src/a1.ts")).toBe(true);
  expect(matcher.ignores("src/x1.ts")).toBe(false);
  // The class must not stand in for the separator and swallow a nested path.
  expect(matcher.ignores("src//a.ts")).toBe(false);
});

test("a character class can hold the closing bracket itself", () => {
  const matcher = gitignoring("[]]", "log[]a].txt");
  expect(matcher.ignores("]")).toBe(true);
  expect(matcher.ignores("log].txt")).toBe(true);
  expect(matcher.ignores("loga.txt")).toBe(true);
  expect(matcher.ignores("logb.txt")).toBe(false);
});

test("an escaped bracket inside a class does not end it", () => {
  const matcher = gitignoring("tmp[a\\]]");
  expect(matcher.ignores("tmpa")).toBe(true);
  expect(matcher.ignores("tmp]")).toBe(true);
  expect(matcher.ignores("tmpb")).toBe(false);
});

test("an unterminated bracket or brace is matched literally", () => {
  expect(excluding("a[b.ts").ignores("a[b.ts")).toBe(true);
  expect(excluding("a{b.ts").ignores("a{b.ts")).toBe(true);
});

// #endregion

// #region gitignore syntax

test("a comment is skipped and an escaped hash is a literal name", () => {
  const matcher = gitignoring("# a comment", "\\#notes.txt");
  expect(matcher.ignores("a comment")).toBe(false);
  expect(matcher.ignores("#notes.txt")).toBe(true);
});

test("an escaped bang is a literal name rather than a negation", () => {
  const matcher = gitignoring("*.log", "\\!important.log");
  expect(matcher.ignores("!important.log")).toBe(true);
  expect(matcher.ignores("important.log")).toBe(true);
});

test("a negation re-includes a file an earlier rule matched", () => {
  const matcher = gitignoring("*.log", "!keep.log");
  expect(matcher.ignores("debug.log")).toBe(true);
  expect(matcher.ignores("keep.log")).toBe(false);
});

test("a negation cannot re-include a file inside an excluded directory", () => {
  // Git never descends into `build/`, so `!build/keep.txt` is never reached.
  const matcher = gitignoring("build/", "!build/keep.txt");
  expect(matcher.ignores("build/keep.txt")).toBe(true);
  expect(matcher.ignores("build/other.txt")).toBe(true);
});

test("re-including the directory itself does put its files back", () => {
  const matcher = gitignoring("build/", "!build/");
  expect(matcher.ignores("build/keep.txt")).toBe(false);
});

test("an excluded ancestor decides at any depth", () => {
  const matcher = gitignoring("build/", "!build/deep/keep.txt");
  expect(matcher.ignores("build/deep/keep.txt")).toBe(true);
  expect(matcher.ignores("src/build.txt")).toBe(false);
});

test("an exclude setting cannot be undone from inside an excluded folder either", () => {
  const matcher = excluding("**/dist/**", "!dist/keep.js");
  expect(matcher.ignores("dist/keep.js")).toBe(true);
});

test("a trailing slash matches only what is inside the directory", () => {
  const matcher = gitignoring("build/");
  expect(matcher.ignores("build/a.js")).toBe(true);
  expect(matcher.ignores("nested/build/a.js")).toBe(true);
  // A regular file called `build` is not the directory the pattern names.
  expect(matcher.ignores("build")).toBe(false);
});

test("blank lines and carriage returns are ignored", () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore("*.log\r\n\r\n   \r\ntmp\r\n");
  expect(matcher.ignores("debug.log")).toBe(true);
  expect(matcher.ignores("tmp")).toBe(true);
  expect(matcher.ignores("keep.ts")).toBe(false);
});

// #endregion

// #region case

test("path case follows the platform, as the rest of the extension does", () => {
  const matcher = excluding("**/dist/**");
  expect(matcher.ignores("dist/a.js")).toBe(true);
  expect(matcher.ignores("Dist/a.js")).toBe(foldsCase);
  expect(matcher.ignores("packages/Dist/a.js")).toBe(foldsCase);
});

// #endregion

// #region rule order

test("the last matching rule decides", () => {
  const matcher = gitignoring("*.log", "!keep.log", "keep.log");
  expect(matcher.ignores("keep.log")).toBe(true);
});

test("patterns added after a gitignore override its negations", () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore("private/**\n!private/a.ts");
  matcher.add(["private/**"]);
  expect(matcher.ignores("private/a.ts")).toBe(true);
});

// #endregion
