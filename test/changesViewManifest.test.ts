import { expect, test } from "vitest";
import manifest from "../package.json";

test("the buttons on the changes panel's rows use commands that never fall back to the editor", () => {
  const rows = manifest.contributes.menus["view/item/context"];
  const palette = manifest.contributes.menus.commandPalette;

  const folder = "view == changelens.changes && viewItem == changelens.folder";
  const file = "view == changelens.changes && viewItem == changelens.file";
  expect(rows.map(({ command, when }) => ({ command, when }))).toEqual([
    { command: "changelens.acceptFolder", when: folder },
    { command: "changelens.openFile", when: file },
    { command: "changelens.acceptFileRow", when: file },
    { command: "changelens.revertFileRow", when: file },
  ]);
  for (const command of ["changelens.acceptFileRow", "changelens.revertFileRow"]) {
    expect(palette.find((entry) => entry.command === command)?.when).toBe("false");
  }
});

test("a row command keeps the title and icon of the editor command it stands in for", () => {
  const commands = manifest.contributes.commands;
  const find = (command: string) => commands.find((entry) => entry.command === command);

  for (const action of ["acceptFile", "revertFile"]) {
    const row = find(`changelens.${action}Row`);
    const editor = find(`changelens.${action}`);
    expect(row?.title).toBe(editor?.title);
    expect(row?.icon).toBe(editor?.icon);
  }
});
