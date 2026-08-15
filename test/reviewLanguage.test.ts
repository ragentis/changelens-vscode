import * as path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { mirrorReviewLanguages } from "../src/ui/reviewLanguage";
import { BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME } from "../src/ui/schemes";
import * as editor from "./helpers/vscode";

const file = path.join(path.sep === "\\" ? "C:\\work" : "/work", "src", "app.ts");

beforeEach(() => {
  editor.reset();
});

/** The retag is fired and not awaited, so a test reads the language after the queue drains. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("retags a review document that is already open", async () => {
  const doc = editor.openDocument(file, "const a = 1;\n", false, REVIEW_SCHEME);

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(doc.languageId).toBe("changelens-typescript");
  subscription.dispose();
});

test("retags a review document opened later", async () => {
  const subscription = mirrorReviewLanguages();
  const doc = editor.openDocument(file, "const a = 1;\n", false, REVIEW_SCHEME);
  editor.state.events.documentOpened.fire(doc);
  await settle();

  expect(doc.languageId).toBe("changelens-typescript");
  subscription.dispose();
});

test("retags every review scheme", async () => {
  const docs = [BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME].map((scheme) =>
    editor.openDocument(file, "const a = 1;\n", false, scheme),
  );

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(docs.map((doc) => doc.languageId)).toEqual([
    "changelens-typescript",
    "changelens-typescript",
    "changelens-typescript",
  ]);
  subscription.dispose();
});

test("retags every mirrored language", async () => {
  const mirrored: [string, string][] = [
    ["app.ts", "changelens-typescript"],
    ["app.tsx", "changelens-typescriptreact"],
    ["app.js", "changelens-javascript"],
    ["app.jsx", "changelens-javascriptreact"],
    ["config.json", "changelens-json"],
    ["settings.jsonc", "changelens-jsonc"],
    ["styles.css", "changelens-css"],
    ["styles.scss", "changelens-scss"],
    ["styles.less", "changelens-less"],
    ["Widget.vue", "changelens-vue"],
    ["notes.mdx", "changelens-mdx"],
    ["pipeline.yaml", "changelens-yaml"],
    ["pipeline.yml", "changelens-yaml"],
  ];
  const docs = mirrored.map(([name]) =>
    editor.openDocument(path.join(path.dirname(file), name), "", false, REVIEW_SCHEME),
  );

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(docs.map((doc) => doc.languageId)).toEqual(mirrored.map(([, mirror]) => mirror));
  subscription.dispose();
});

test("retags languages the editor assigns by path pattern", async () => {
  const compose = editor.openDocument(
    path.join(path.dirname(file), "compose.yaml"),
    "",
    false,
    REVIEW_SCHEME,
  );
  compose.languageId = "dockercompose";
  const workflow = editor.openDocument(
    path.join(path.dirname(file), "ci.yml"),
    "",
    false,
    REVIEW_SCHEME,
  );
  workflow.languageId = "github-actions-workflow";

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(compose.languageId).toBe("changelens-dockercompose");
  expect(workflow.languageId).toBe("changelens-github-actions-workflow");
  subscription.dispose();
});

test("leaves the working file alone", async () => {
  const doc = editor.openDocument(file, "const a = 1;\n");

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(doc.languageId).toBe("typescript");
  subscription.dispose();
});

test("leaves a language without a mirror alone", async () => {
  const doc = editor.openDocument(
    path.join(path.dirname(file), "notes.md"),
    "# notes\n",
    false,
    REVIEW_SCHEME,
  );

  const subscription = mirrorReviewLanguages();
  await settle();

  expect(doc.languageId).toBe("plaintext");
  subscription.dispose();
});

test("settles instead of retagging what it already retagged", async () => {
  const doc = editor.openDocument(file, "const a = 1;\n", false, REVIEW_SCHEME);
  let opens = 0;
  const counter = editor.workspace.onDidOpenTextDocument(() => {
    opens += 1;
  });

  const subscription = mirrorReviewLanguages();
  await settle();

  // Retagging reopens the document, which would retag it again if the mirror had a mirror.
  expect(opens).toBe(1);
  expect(doc.languageId).toBe("changelens-typescript");
  counter.dispose();
  subscription.dispose();
});

test("stops retagging once disposed", async () => {
  const subscription = mirrorReviewLanguages();
  subscription.dispose();

  const doc = editor.openDocument(file, "const a = 1;\n", false, REVIEW_SCHEME);
  editor.state.events.documentOpened.fire(doc);
  await settle();

  expect(doc.languageId).toBe("typescript");
});
