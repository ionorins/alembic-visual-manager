import * as vscode from 'vscode';
import { AlembicService } from './services/alembicService';
import { GraphViewProvider } from './views/graphViewProvider';

let alembicService: AlembicService;
let graphViewProvider: GraphViewProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('Alembic Visual Manager is now active!');

    alembicService = new AlembicService();
    graphViewProvider = new GraphViewProvider(context.extensionUri, alembicService);

    const showGraphCommand = vscode.commands.registerCommand('alembic.showMigrationGraph', () => {
        graphViewProvider.show();
    });

    const createRevisionCommand = vscode.commands.registerCommand('alembic.createRevision', async () => {
        const message = await vscode.window.showInputBox({
            prompt: 'Enter revision message',
            placeHolder: 'Add new feature'
        });
        
        if (message) {
            const autogenerate = await vscode.window.showQuickPick(
                ['Yes', 'No'],
                { placeHolder: 'Auto-generate migration?' }
            );
            
            try {
                await alembicService.createRevision(message, autogenerate === 'Yes');
                vscode.window.showInformationMessage(`Created revision: ${message}`);
                graphViewProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create revision: ${error}`);
            }
        }
    });

    const upgradeToHeadCommand = vscode.commands.registerCommand('alembic.upgradeToHead', async () => {
        try {
            await alembicService.upgrade('head');
            vscode.window.showInformationMessage('Upgraded to head successfully');
            graphViewProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to upgrade: ${error}`);
        }
    });

    context.subscriptions.push(showGraphCommand, createRevisionCommand, upgradeToHeadCommand);

    if (vscode.workspace.workspaceFolders) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const alembicIniPath = `${workspaceRoot}/backend/alembic.ini`;
        
        vscode.workspace.fs.stat(vscode.Uri.file(alembicIniPath)).then(() => {
            vscode.window.showInformationMessage('Alembic project detected!', 'Show Migration Graph')
                .then(selection => {
                    if (selection) {
                        vscode.commands.executeCommand('alembic.showMigrationGraph');
                    }
                });
        }, () => {
            // Silently ignore if alembic.ini is not found
        });
    }
}

export function deactivate() {}