# PolyGlot — VS Code Extension

Visualize your codebase dependencies and impact analysis directly in VS Code. See file relationships, dependencies, and AI-powered insights without leaving your editor.

## Features

- 📊 **Dependency Graph Visualization** — Explore your codebase structure in an interactive graph
- 💡 **Hover Intelligence** — See file summaries, dependencies, and usage information on hover
- 🔍 **Impact Analysis** — Understand which files are affected by your changes
- 🤖 **AI Refactor Suggestions** — Get actionable refactoring recommendations
- 🎨 **Dark Mode Support** — Matches your VS Code theme

## Installation

1. **From VS Code Marketplace:**
   - Open VS Code
   - Go to Extensions (Ctrl/Cmd + Shift + X)
   - Search for "PolyGlot"
   - Click Install

2. **From Source (Development):**
```bash
git clone https://github.com/polyglot/polyglot.git
cd vscode-extension
npm install
npm run esbuild
# Open vscode-extension folder in VS Code
# Press F5 to launch the extension in development mode
```

## Configuration

Add to your VS Code settings (`.vscode/settings.json` or globally):

```json
{
  "polyglot.serverUrl": "http://localhost:5000",
  "polyglot.apiToken": "your-jwt-token-here"
}
```

### Settings

- **`polyglot.serverUrl`** — URL of your PolyGlot server (default: `http://localhost:5000`)
- **`polyglot.apiToken`** — JWT token for authentication with the server (optional)

## Usage

### Opening the Graph

1. Open a supported file (`.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.go`)
2. Run the command **"PolyGlot: Open Graph"** from the Command Palette (Ctrl/Cmd + Shift + P)
3. A new panel opens showing your dependency graph

### Hover Information

Hover over any file in your editor to see:
- File summary and description
- Number of direct dependencies
- Number of files that depend on it
- Quick link to open the full graph

### Keyboard Shortcuts

- `Ctrl/Cmd + Shift + P` → Open Command Palette
- Type "PolyGlot" to find available commands

## Supported Languages

- JavaScript / TypeScript
- JSX / TSX
- Python
- Go

## Requirements

- VS Code 1.85 or later
- PolyGlot server running (local or remote)
- Valid JWT authentication token (if server requires authentication)

## Development

### Build

```bash
npm run esbuild         # Build once
npm run esbuild-watch   # Watch mode for development
npm run vscode:prepublish  # Production build with minification
```

### Type Checking

```bash
npm run typecheck
```

### Package for Distribution

```bash
npm install -g @vscode/vsce
vsce package   # Generates .vsix file
vsce publish   # Publish to VS Code Marketplace (requires credentials)
```

## Architecture

### Files

- **`src/extension.ts`** — Extension activation and command registration
- **`src/HoverProvider.ts`** — VS Code hover provider implementation
- **`src/GraphPanel.ts`** — WebviewPanel managing the graph visualization
- **`src/ApiClient.ts`** — HTTP client for PolyGlot backend communication
- **`media/main.js`** — Webview script for graph rendering
- **`media/main.css`** — Webview styles

### Communication Flow

```
VS Code Extension
    ↓
ApiClient (HTTP)
    ↓
PolyGlot Backend API
    ↓
Graph Visualization (Webview)
```

## Troubleshooting

### "No workspace folder open"

- Open a folder in VS Code (File → Open Folder)

### "Connection refused" / "Failed to fetch graph"

- Verify the PolyGlot server is running
- Check `polyglot.serverUrl` setting
- Ensure firewall allows the connection

### Hover information not showing

- The file must be from an analyzed repository
- Set a valid Job ID from a completed analysis
- Verify network connectivity to the server

## Contributing

Found a bug or have a feature request? Open an issue on GitHub:  
https://github.com/polyglot/polyglot/issues

## License

MIT — See LICENSE file in the repository

## Support

- 📖 [Documentation](https://github.com/polyglot/polyglot#readme)
- 💬 [Discussions](https://github.com/polyglot/polyglot/discussions)
- 🐛 [Issues](https://github.com/polyglot/polyglot/issues)

---

**Developed by the PolyGlot team**
# CodeGraph AI — VS Code Extension

Visualize your codebase dependencies and impact analysis directly in VS Code. See file relationships, dependencies, and AI-powered insights without leaving your editor.

## Features

- 📊 **Dependency Graph Visualization** — Explore your codebase structure in an interactive graph
- 💡 **Hover Intelligence** — See file summaries, dependencies, and usage information on hover
- 🔍 **Impact Analysis** — Understand which files are affected by your changes
- 🤖 **AI Refactor Suggestions** — Get actionable refactoring recommendations
- 🎨 **Dark Mode Support** — Matches your VS Code theme

## Installation

1. **From VS Code Marketplace:**
   - Open VS Code
   - Go to Extensions (Ctrl/Cmd + Shift + X)
   - Search for "CodeGraph AI"
   - Click Install

2. **From Source (Development):**
   ```bash
   git clone https://github.com/codegraph-ai/codegraph-ai.git
   cd vscode-extension
   npm install
   npm run esbuild
   # Open vscode-extension folder in VS Code
   # Press F5 to launch the extension in development mode
   ```

## Configuration

Add to your VS Code settings (`.vscode/settings.json` or globally):

```json
{
  "codegraphAi.serverUrl": "http://localhost:5000",
  "codegraphAi.apiToken": "your-jwt-token-here"
}
```

### Settings

- **`codegraphAi.serverUrl`** — URL of your CodeGraph AI server (default: `http://localhost:5000`)
- **`codegraphAi.apiToken`** — JWT token for authentication with the server (optional)

## Usage

### Opening the Graph

1. Open a supported file (`.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.go`)
2. Run the command **"CodeGraph AI: Open Graph"** from the Command Palette (Ctrl/Cmd + Shift + P)
3. A new panel opens showing your dependency graph

### Hover Information

Hover over any file in your editor to see:
- File summary and description
- Number of direct dependencies
- Number of files that depend on it
- Quick link to open the full graph

### Keyboard Shortcuts

- `Ctrl/Cmd + Shift + P` → Open Command Palette
- Type "CodeGraph AI" to find available commands

## Supported Languages

- JavaScript / TypeScript
- JSX / TSX
- Python
- Go

## Requirements

- VS Code 1.85 or later
- CodeGraph AI server running (local or remote)
- Valid JWT authentication token (if server requires authentication)

## Development

### Build

```bash
npm run esbuild         # Build once
npm run esbuild-watch   # Watch mode for development
npm run vscode:prepublish  # Production build with minification
```

### Type Checking

```bash
npm run typecheck
```

### Package for Distribution

```bash
npm install -g @vscode/vsce
vsce package   # Generates .vsix file
vsce publish   # Publish to VS Code Marketplace (requires credentials)
```

## Architecture

### Files

- **`src/extension.ts`** — Extension activation and command registration
- **`src/HoverProvider.ts`** — VS Code hover provider implementation
- **`src/GraphPanel.ts`** — WebviewPanel managing the graph visualization
- **`src/ApiClient.ts`** — HTTP client for CodeGraph backend communication
- **`media/main.js`** — Webview script for graph rendering
- **`media/main.css`** — Webview styles

### Communication Flow

```
VS Code Extension
    ↓
ApiClient (HTTP)
    ↓
CodeGraph Backend API
    ↓
Graph Visualization (Webview)
```

## Troubleshooting

### "No workspace folder open"
- Open a folder in VS Code (File → Open Folder)

### "Connection refused" / "Failed to fetch graph"
- Verify the CodeGraph server is running
- Check `codegraphAi.serverUrl` setting
- Ensure firewall allows the connection

### Hover information not showing
- The file must be from an analyzed repository
- Set a valid Job ID from a completed analysis
- Verify network connectivity to the server

## Contributing

Found a bug or have a feature request? Open an issue on GitHub:  
https://github.com/codegraph-ai/codegraph-ai/issues

## License

MIT — See LICENSE file in the repository

## Support

- 📖 [Documentation](https://github.com/codegraph-ai/codegraph-ai#readme)
- 💬 [Discussions](https://github.com/codegraph-ai/codegraph-ai/discussions)
- 🐛 [Issues](https://github.com/codegraph-ai/codegraph-ai/issues)

---

**Developed by the CodeGraph AI team**
