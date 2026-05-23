// This will be loaded in the webview
// It handles communication between the extension and the webview content

(function () {
  const vscode = window.vscode;

  // Initialize the webview
  const root = document.getElementById('root');

  // Create a simple UI for now until React graph is built
  const html = `
    <div class="container">
      <div class="header">
        <h1>PolyGlot</h1>
        <div class="controls">
          <button id="refreshBtn">Refresh</button>
          <button id="settingsBtn">Settings</button>
        </div>
      </div>

      <div class="info" id="infoMsg" style="display: none;">
        No graph loaded. Run an analysis on your repository to get started.
      </div>

      <div class="error" id="errorMsg" style="display: none;"></div>

      <div id="content" style="display: none;">
        <div class="stats" id="stats"></div>
        <div class="graph-container" id="graphContainer">
          <div class="loading">Loading graph visualization...</div>
        </div>
      </div>
    </div>
  `;

  root.innerHTML = html;

  // Setup event listeners
  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' });
  });

  document.getElementById('settingsBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'openSettings' });
  });

  // Listen for messages from the extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    console.log('Webview received message:', message);

    switch (message.command) {
      case 'graphLoaded':
        handleGraphLoaded(message.data);
        break;
      case 'error':
        showError(message.message);
        break;
      case 'refactorSuggestions':
        showRefactorSuggestions(message.data);
        break;
    }
  });

  function handleGraphLoaded(data) {
    const infoMsg = document.getElementById('infoMsg');
    const content = document.getElementById('content');
    const stats = document.getElementById('stats');

    infoMsg.style.display = 'none';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';

    // Display basic stats
    const nodeCount = Object.keys(data.graph || {}).length;
    const edgeCount = data.edges ? data.edges.length : 0;

    stats.innerHTML = `
      <div class="stat-item">
        <div class="stat-label">Files</div>
        <div class="stat-value">${nodeCount}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Dependencies</div>
        <div class="stat-value">${edgeCount}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Job ID</div>
        <div class="stat-value" style="font-size: 12px; word-break: break-all;">${data.jobId.slice(0, 12)}...</div>
      </div>
    `;

    // TODO: Render actual graph visualization here
    document.getElementById('graphContainer').innerHTML = `
      <div class="info" style="margin: 16px;">
        Graph visualization coming soon. Your codebase has ${nodeCount} files with ${edgeCount} dependencies.
      </div>
    `;
  }

  function showError(message) {
    const errorMsg = document.getElementById('errorMsg');
    const content = document.getElementById('content');

    errorMsg.textContent = message;
    errorMsg.style.display = 'block';
    content.style.display = 'none';
  }

  function showRefactorSuggestions(data) {
    console.log('Refactor suggestions:', data);
    // TODO: Display suggestions in a panel
  }

  // Signal that webview is ready
  vscode.postMessage({ command: 'webviewReady' });
})();
