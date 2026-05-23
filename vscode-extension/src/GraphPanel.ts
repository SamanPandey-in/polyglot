import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient } from './ApiClient';

/**
 * Manages the WebviewPanel that displays the CodeGraph visualization
 */
export class GraphPanel {
  public static currentPanel: GraphPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _apiClient: ApiClient;
  private _repoPath: string;

  public static createOrShow(extensionUri: vscode.Uri, apiClient: ApiClient, repoPath: string) {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    // If we already have a panel, show it
    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel._panel.reveal(column);
      GraphPanel.currentPanel._update(repoPath);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'polyglotGraph',
      'PolyGlot',
      column,
      {
        enableScripts: true,
        enableForms: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    GraphPanel.currentPanel = new GraphPanel(panel, extensionUri, apiClient, repoPath);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    apiClient: ApiClient,
    repoPath: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._apiClient = apiClient;
    this._repoPath = repoPath;

    // Update the html for the webview
    this._update(repoPath);

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'webviewReady':
          case 'refresh':
            await this._sendGraphData();
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'polyglot');
            break;
          case 'selectJobId':
            this._apiClient.setCurrentJobId(message.jobId);
            vscode.window.showInformationMessage(`Loaded graph for job ${message.jobId.slice(0, 8)}...`);
            break;
          case 'openFile':
            this._openFile(message.filePath);
            break;
          case 'getRefactorSuggestions':
            this._getRefactorSuggestions(message.filePath);
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    GraphPanel.currentPanel = undefined;

    // Clean up resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update(repoPath: string) {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, repoPath);
  }

  private async _sendGraphData() {
    const jobId = this._apiClient.currentJobId;
    if (!jobId) {
      this._panel.webview.postMessage({ command: 'error', message: 'No graph loaded. Run an analysis first.' });
      return;
    }
    try {
      const data = await this._apiClient.getGraph(jobId);
      this._panel.webview.postMessage({ command: 'graphLoaded', data: { ...data, jobId } });
    } catch (err) {
      this._panel.webview.postMessage({ command: 'error', message: (err as Error).message });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview, repoPath: string): string {
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!--
    Use a content security policy to only allow loading images and scripts from https.
    On development, http is used too.
    * img-src data: https: 'unsafe-inline' http:;
    * connect-src https: wss: http: ws:;
  -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; connect-src https: http: wss: ws:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleResetUri}">
  <link rel="stylesheet" href="${styleMainUri}">
  <title>PolyGlot</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.vscode = acquireVsCodeApi();
    window.repoPath = "${escapeHtml(repoPath)}";
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _openFile(filePath: string) {
    const fullPath = path.join(this._repoPath, filePath);
    vscode.workspace.openTextDocument(fullPath).then(
      (doc) => {
        vscode.window.showTextDocument(doc, { preview: false });
      },
      (err) => {
        vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
      }
    );
  }

  private async _getRefactorSuggestions(filePath: string) {
    try {
      if (!this._apiClient.currentJobId) {
        vscode.window.showErrorMessage('No job loaded. Please load a graph first.');
        return;
      }

      const suggestions = await this._apiClient.getRefactorSuggestions(
        this._apiClient.currentJobId,
        filePath
      );

      this._panel.webview.postMessage({
        command: 'refactorSuggestions',
        data: suggestions,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get refactor suggestions: ${(err as Error).message}`);
    }
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
