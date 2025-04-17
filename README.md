# Cline Community MCP Server

A Model Context Protocol server that simplifies reporting issues from Cline to GitHub.

## Overview

This MCP server provides tools to streamline the process of reporting issues from Cline to the GitHub repository. It automatically gathers relevant system information (OS, Cline version, API provider, model), formats it alongside the user's issue description, and can preview how the issue would look before submitting it to GitHub.

## Features

- **Cross-platform support**: Works on Windows, macOS, and Linux
- **Multiple IDE support**: Compatible with VS Code, Cursor, and Windsurf
- **Automatic metadata extraction**: Gets API provider, model, and IDE information from task metadata
- **Two-step issue reporting workflow**:
  1. Preview the issue before submission
  2. Submit to GitHub with a single command
- **GitHub Integration**: Uses the GitHub CLI (`gh`) to create issues

## Tools

### `preview_cline_issue`

Previews how an issue would look when reported to GitHub without actually submitting it.

**Parameters**:

- `title`: The title for the GitHub issue (required)
- `description`: Detailed description of the problem (required)
- `labels`: Optional array of GitHub labels to apply

**Returns**: JSON object containing the formatted issue with:

- Title
- Body (including system information)
- Labels
- Target repository

### `report_cline_issue`

Reports an issue to the GitHub repository using the locally authenticated GitHub CLI.

**Parameters**:

- `title`: The title for the GitHub issue (required)
- `description`: Detailed description of the problem (required)
- `labels`: Optional array of GitHub labels to apply

**Returns**: The URL of the created GitHub issue or an error message

## Automatic Information Gathering

The server automatically collects:

- **OS Information**: Platform and release version
- **Cline Version**: Detected from installed extensions
- **IDE Information**: Identifies which IDE is being used (VS Code, Cursor, or Windsurf)
- **API Provider**: Extracted from the task metadata file
- **Model**: Extracted from the task metadata file

## Requirements

- GitHub CLI (`gh`) installed and authenticated
- Access to task metadata directories (where Cline stores information about the current task)
- Github token

## Installation

### Build from Source

```bash
# Install dependencies
npm install

# Build the server
npm run build
```

### Configure with Cline

Add the server to your MCP settings:

#### For Cline in VS Code/Cursor

Add to Cline MCP settings:

- **macOS**: `~/Library/Application Support/[Code|Cursor|Windsurf]/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Windows**: `%APPDATA%/[Code|Cursor|Windsurf]/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux**: `~/.config/[Code|Cursor|Windsurf]/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "cline-community": {
      "command": "node",
      "args": ["/path/to/cline-community/build/index.js"]
    }
  }
}
```

### Windows-Specific Configuration

On Windows, you may need to explicitly set the APPDATA environment variable in the MCP settings:

```json
{
  "mcpServers": {
    "cline-community": {
      "command": "node",
      "args": ["/path/to/cline-community/build/index.js"],
      "env": {
        "APPDATA": "C:\\Users\\[username]\\AppData\\Roaming"
      }
    }
  }
}
```

Replace `[username]` with your Windows username.

## Usage Example

To report an issue:

1. Use `preview_cline_issue` first to see how your issue will look:

   ```
   preview_cline_issue(
     title: "Feature request: Add dark mode",
     description: "It would be great to have a dark mode option to reduce eye strain.",
     labels: ["Enhancement"]
   )
   ```

2. Review the preview and then submit with:
   ```
   report_cline_issue(
     title: "Feature request: Add dark mode",
     description: "It would be great to have a dark mode option to reduce eye strain.",
     labels: ["Enhancement"]
   )
   ```

## Development

For development with auto-rebuild:

```bash
npm run watch
```

### Debugging

Since MCP servers communicate over stdio, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) for debugging:

```bash
npm run inspector
```