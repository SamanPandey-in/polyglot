import * as vscode from 'vscode';
import { GraphPanel } from './GraphPanel';
import { HoverProvider } from './HoverProvider';
import { ApiClient } from './ApiClient';

export function activate(context: vscode.ExtensionContext) {
  const apiClient = new ApiClient(
    vscode.workspace.getConfiguration('polyglot').get('serverUrl') || 'http://localhost:5000',
    vscode.workspace.getConfiguration('polyglot').get('apiToken') || ''
  );

  // Command: Open graph for current workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('polyglot.openGraph', async () => {
      const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!repoPath) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      GraphPanel.createOrShow(context.extensionUri, apiClient, repoPath);
    })
  );

  // Hover: show file summary + dep count
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'],
      new HoverProvider(apiClient)
    )
  );
}

export function deactivate() {}
