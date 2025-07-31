# Alembic Visual Manager

A Visual Studio Code extension that provides a rich, interactive graphical user interface for managing Alembic database migrations with advanced features for complex migration scenarios.

## Features

- **Interactive Migration Graph**: SVG-based DAG visualization with pan, zoom, and drag functionality
- **Real-time Updates**: Auto-refresh when migration files change, with file system watchers
- **Advanced Operations**: Full support for upgrade, downgrade, stamp, and revision creation
- **Dependency Modification**: Visual interface to modify migration dependencies by rewriting Python files
- **File Integration**: Click nodes to open migration files directly in the editor

## Requirements

- Python with Alembic installed
- An Alembic project with `alembic.ini` in your workspace (supports backend/ subdirectory structure)

## Extension Settings

This extension contributes the following settings:

- `alembic.scriptPath`: Path to the Python executable or virtual environment (default: "python")
- `alembic.customArgs`: Custom -x arguments to pass to Alembic commands (default: [])

## Usage

1. Open a workspace containing an Alembic project
2. The extension automatically detects `backend/alembic.ini` and shows a notification
3. Run "Alembic: Show Migration Graph" from the Command Palette or click the notification
4. Use the interactive graph to manage your migrations

## Commands

- `Alembic: Show Migration Graph` - Opens the interactive migration graph webview
- `Alembic: Create New Revision` - Creates a new migration revision with optional autogenerate
- `Alembic: Upgrade to Head` - Upgrades database to the latest revision

## Graph Features

### Interactive Elements

- **Pan & Zoom**: Mouse-based navigation with smooth transforms
- **Drag Nodes**: Reposition nodes visually (positions are preserved)
- **Click to Open**: Click any node to open its migration file
- **Context Menus**: Right-click for upgrade, downgrade, and stamp operations

### Node Types & Styling

- **Current Revisions**: Blue highlighted nodes showing applied migrations
- **Head Revisions**: Green nodes indicating branch heads  
- **Merge Points**: Dashed borders for merge revisions
- **Unapplied**: Dimmed opacity for revisions not yet applied

### Advanced Features

- **Dependency Modification**: Toggle modify mode to visually change migration parents
- **File System Watching**: Auto-refresh when files in `alembic/versions/` change
- **Progress Indicators**: Visual feedback during long-running operations
- **Error Handling**: Graceful error display with detailed messages

## Architecture

### Core Components

- `extension.ts`: Main extension entry point with command registration
- `alembicService.ts`: Python subprocess management and output parsing
- `graphViewProvider.ts`: Webview management with SVG rendering and file watching

## Development

### Setup

```bash
npm install
npm run compile
```

### Testing

Press F5 to launch Extension Development Host with the extension loaded.

### Build & Package

```bash
vsce package
```

### Install package

```bash
cursor --install-extension alembic-visual-manager-x.y.z.vsix
```

## License

MIT License - see LICENSE file for details.
