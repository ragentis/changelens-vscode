import * as vscode from "vscode";
import type { ChangeModel } from "../model";

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: ChangeModel) {
    this.item.command = "changelens.changes.focus";
    this.subscription = model.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const count = this.model.files.length;
    if (count === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(diff-multiple) ${count}`;
    this.item.tooltip = `ChangeLens: ${count} file${count === 1 ? "" : "s"} awaiting review`;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
