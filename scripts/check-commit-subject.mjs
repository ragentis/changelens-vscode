// Keep one commit-subject contract for the local hook, future PR titles, and pushed commits. Release
// Please otherwise ignores an invalid subject without producing a version or changelog entry.

import { readFile } from "node:fs/promises";

// Read types from Release Please so validation cannot accept a commit that produces no release note.
const config = JSON.parse(
  await readFile(new URL("../release-please-config.json", import.meta.url), "utf8"),
);
const types = config["changelog-sections"].map((section) => section.type);

const SUBJECT = new RegExp(String.raw`^(${types.join("|")})(\([a-z0-9./-]+\))?!?: .+`);

// Ignore split-input blank lines, but reject an explicitly empty argument.
const subjects =
  process.argv.length > 2
    ? process.argv.slice(2)
    : (await readLines()).filter((line) => line.trim().length > 0);

const rejected = subjects.filter((subject) => !SUBJECT.test(subject.trim()));

if (rejected.length > 0) {
  for (const subject of rejected) {
    console.error(`Not a conventional subject: ${subject || "(empty)"}`);
  }
  console.error("See .github/commit-instructions.md for the types and the shape.");
  process.exit(1);
}

async function readLines() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.split("\n");
}
