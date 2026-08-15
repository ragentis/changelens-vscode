import { expect, test } from "vitest";
import manifest from "../package.json";

test("Unified review actions occupy one ordered editor-title range", () => {
  const toolbar = manifest.contributes.menus["editor/title"].filter(
    ({ group, when }) => group.startsWith("navigation@") && when.includes("changelens-review"),
  );

  expect(toolbar.map(({ command, group }) => ({ command, group }))).toEqual([
    { command: "changelens.acceptHunkAtCursor", group: "navigation@0.1" },
    { command: "changelens.revertHunkAtCursor", group: "navigation@0.2" },
    { command: "changelens.previousChange", group: "navigation@0.3" },
    { command: "changelens.nextChange", group: "navigation@0.4" },
    { command: "changelens.openFile", group: "navigation@0.5" },
  ]);
});

test("ChangeLens navigation is contributed only to the Unified review", () => {
  const toolbar = manifest.contributes.menus["editor/title"];

  for (const command of ["changelens.previousChange", "changelens.nextChange"]) {
    const item = toolbar.find((entry) => entry.command === command);
    expect(item?.when).toBe("resourceScheme == changelens-review && changelens.activeFileHasHunks");
  }
});
