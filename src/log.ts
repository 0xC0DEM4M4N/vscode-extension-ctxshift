import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('CtxShift');
  ctx.subscriptions.push(channel);
}

export function log(msg: string): void {
  channel?.appendLine(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
}

export function showLog(): void {
  channel?.show(true);
}
