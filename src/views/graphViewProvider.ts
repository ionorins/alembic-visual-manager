import * as vscode from 'vscode';
import { AlembicService, RevisionInfo } from '../services/alembicService';

export class GraphViewProvider {
    private panel: vscode.WebviewPanel | undefined;
    private readonly extensionUri: vscode.Uri;
    private readonly alembicService: AlembicService;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private configWatcher: vscode.FileSystemWatcher | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(extensionUri: vscode.Uri, alembicService: AlembicService) {
        this.extensionUri = extensionUri;
        this.alembicService = alembicService;
    }

    public show(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'alembicGraph',
            'Alembic Migration Graph',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri]
            }
        );

        this.panel.webview.html = this.getWebviewContent();
        this.setupMessageHandling();
        this.setupAutoRefresh();
        this.loadRevisions();

        this.panel.onDidDispose(() => {
            this.cleanup();
            this.panel = undefined;
        });
    }

    public refresh(): void {
        if (this.panel) {
            this.loadRevisions();
        }
    }

    private setupAutoRefresh(): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        // Watch for changes in alembic/versions directory
        const alembicVersionsPattern = new vscode.RelativePattern(workspaceRoot, '**/alembic/versions/**/*.py');
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(alembicVersionsPattern);

        this.fileWatcher.onDidCreate(() => this.scheduleRefresh());
        this.fileWatcher.onDidChange(() => this.scheduleRefresh());
        this.fileWatcher.onDidDelete(() => this.scheduleRefresh());

        // Also watch alembic.ini and env.py for configuration changes
        const alembicConfigPattern = new vscode.RelativePattern(workspaceRoot, '**/alembic/{alembic.ini,env.py}');
        this.configWatcher = vscode.workspace.createFileSystemWatcher(alembicConfigPattern);
        this.configWatcher.onDidChange(() => this.scheduleRefresh());
    }

    private scheduleRefresh(): void {
        // Debounce multiple rapid changes
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        
        this.refreshTimer = setTimeout(() => {
            this.refresh();
        }, 1000); // Wait 1 second after last change
    }

    private cleanup(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }
        if (this.configWatcher) {
            this.configWatcher.dispose();
            this.configWatcher = undefined;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async loadRevisions(): Promise<void> {
        if (!this.panel) return;

        try {
            const revisions = await this.alembicService.getHistory();
            this.panel.webview.postMessage({
                type: 'updateRevisions',
                data: revisions
            });
            
            // Send refresh notification
            this.panel.webview.postMessage({
                type: 'refreshComplete',
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load revisions: ${errorMessage}`);
            this.panel.webview.postMessage({
                type: 'error',
                data: errorMessage
            });
        }
    }

    private setupMessageHandling(): void {
        if (!this.panel) return;

        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'openRevisionFile':
                    await this.openRevisionFile(message.revisionId);
                    break;
                case 'upgradeToRevision':
                    await this.upgradeToRevision(message.revisionId);
                    break;
                case 'downgradeToRevision':
                    await this.downgradeToRevision(message.revisionId);
                    break;
                case 'stampRevision':
                    await this.stampRevision(message.revisionId);
                    break;
                case 'modifyDependency':
                    console.log('Received modifyDependency message:', message);
                    await this.modifyDependency(message.revisionId, message.newParent);
                    break;
                case 'ready':
                    this.loadRevisions();
                    break;
            }
        });
    }

    private async openRevisionFile(revisionId: string): Promise<void> {
        try {
            const filePath = await this.alembicService.getRevisionFilePath(revisionId);
            if (filePath) {
                const document = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(document);
            } else {
                vscode.window.showWarningMessage(`Could not find file for revision ${revisionId}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open revision file: ${error}`);
        }
    }

    private async upgradeToRevision(revisionId: string): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Upgrading to revision ${revisionId}...`,
                cancellable: false
            }, async () => {
                await this.alembicService.upgrade(revisionId);
            });
            
            vscode.window.showInformationMessage(`Successfully upgraded to revision ${revisionId}`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to upgrade: ${error}`);
        }
    }

    private async downgradeToRevision(revisionId: string): Promise<void> {
        const confirmed = await vscode.window.showWarningMessage(
            `Are you sure you want to downgrade to revision ${revisionId}? This action cannot be undone.`,
            'Yes', 'No'
        );

        if (confirmed === 'Yes') {
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Downgrading to revision ${revisionId}...`,
                    cancellable: false
                }, async () => {
                    await this.alembicService.downgrade(revisionId);
                });
                
                vscode.window.showInformationMessage(`Successfully downgraded to revision ${revisionId}`);
                this.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to downgrade: ${error}`);
            }
        }
    }

    private async stampRevision(revisionId: string): Promise<void> {
        const confirmed = await vscode.window.showWarningMessage(
            `Are you sure you want to stamp revision ${revisionId}? This will mark it as applied without running the migration.`,
            'Yes', 'No'
        );

        if (confirmed === 'Yes') {
            try {
                await this.alembicService.stamp(revisionId);
                vscode.window.showInformationMessage(`Successfully stamped revision ${revisionId}`);
                this.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to stamp revision: ${error}`);
            }
        }
    }

    private async modifyDependency(revisionId: string, newParent: string): Promise<void> {
        console.log('modifyDependency called with:', { revisionId, newParent });
        const confirmed = await vscode.window.showWarningMessage(
            `⚠️ Warning: You are about to change the parent of revision ${revisionId} to ${newParent}. This will modify the Python source file directly and can corrupt your migration history if not done carefully. This action cannot be undone. Are you sure you wish to proceed?`,
            'Yes', 'No'
        );

        if (confirmed === 'Yes') {
            try {
                const filePath = await this.alembicService.getRevisionFilePath(revisionId);
                if (filePath) {
                    const document = await vscode.workspace.openTextDocument(filePath);
                    const text = document.getText();
                    
                    let updatedText = text;
                    
                    // Update the docstring "Revises:" line
                    updatedText = updatedText.replace(
                        /^Revises:\s*[^\r\n]*/m,
                        `Revises: ${newParent}`
                    );
                    
                    // Update the down_revision variable
                    updatedText = updatedText.replace(
                        /down_revision\s*=\s*['"][^'"]*['"]/,
                        `down_revision = "${newParent}"`
                    );
                    
                    // Handle the case where down_revision is None (for base revision)
                    if (newParent === '<base>' || newParent === 'None') {
                        updatedText = updatedText.replace(
                            /^Revises:\s*[^\r\n]*/m,
                            `Revises:`
                        );
                        updatedText = updatedText.replace(
                            /down_revision\s*=\s*['"][^'"]*['"]/,
                            `down_revision = None`
                        );
                    }
                    
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), updatedText);
                    await vscode.workspace.applyEdit(edit);
                    await document.save();
                    
                    vscode.window.showInformationMessage(`Successfully modified dependency for revision ${revisionId}`);
                    this.refresh();
                } else {
                    vscode.window.showErrorMessage(`Could not find file for revision ${revisionId}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to modify dependency: ${error}`);
            }
        }
    }

    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Alembic Migration Graph</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            height: 100vh;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        
        .toolbar {
            padding: 10px;
            background-color: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        
        .btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .graph-container {
            height: calc(100vh - 60px);
            position: relative;
            overflow: hidden;
        }
        
        .loading {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100%;
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        
        .error {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: var(--vscode-errorForeground);
            text-align: center;
            padding: 20px;
        }
        
        .node {
            padding: 8px;
            border-radius: 4px;
            border: 2px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            cursor: pointer;
            min-width: 150px;
            text-align: center;
            font-size: 11px;
        }
        
        .node.current {
            border-color: var(--vscode-button-background);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .node.head {
            border-color: var(--vscode-gitDecoration-modifiedResourceForeground);
            background-color: var(--vscode-gitDecoration-modifiedResourceForeground);
            color: var(--vscode-button-foreground);
        }
        
        .node.merge {
            border-style: dashed;
        }
        
        .node.unapplied {
            opacity: 0.6;
        }
        
        .node-id {
            font-family: monospace;
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .node-message {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            word-wrap: break-word;
        }
        
        .context-menu {
            position: absolute;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 3px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 1000;
            min-width: 150px;
        }
        
        .context-menu-item {
            padding: 8px 12px;
            cursor: pointer;
            font-size: 12px;
            border-bottom: 1px solid var(--vscode-menu-separatorBackground);
        }
        
        .context-menu-item:last-child {
            border-bottom: none;
        }
        
        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }
        
        #graph {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        
        #graphSvg {
            cursor: grab;
        }
        
        #graphSvg.panning {
            cursor: grabbing;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="btn" onclick="upgradeToHead()">Upgrade to Head</button>
        <button class="btn" onclick="toggleModifyMode()" id="modifyBtn">Modify Dependencies</button>
        <button class="btn" onclick="refresh()">Refresh</button>
        <div id="refreshStatus" style="margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center;">
            Auto-refresh enabled
        </div>
    </div>
    
    <div class="graph-container">
        <div id="loading" class="loading">Loading migration history...</div>
        <div id="error" class="error" style="display: none;"></div>
        <div id="graph" style="display: none;"></div>
    </div>
    
    <div id="contextMenu" class="context-menu" style="display: none;"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let revisions = [];
        let modifyMode = false;
        let selectedHeads = [];
        let selectedNode = null;
        let isPanning = false;
        let panStart = { x: 0, y: 0 };
        let currentTransform = { x: 0, y: 0, scale: 1 };
        let isDragging = false;
        let dragNode = null;
        let dragStart = { x: 0, y: 0 };
        let nodePositions = {};
        let justFinishedDragging = false;
        let actuallyDragged = false;
        
        window.addEventListener('load', () => {
            vscode.postMessage({ type: 'ready' });
        });
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateRevisions':
                    revisions = message.data;
                    renderGraph();
                    break;
                case 'error':
                    showError(message.data);
                    break;
                case 'refreshComplete':
                    updateRefreshStatus('Refreshed at ' + message.timestamp);
                    break;
            }
        });
        
        function showError(error) {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('graph').style.display = 'none';
            document.getElementById('error').style.display = 'flex';
            document.getElementById('error').textContent = error;
        }
        
        function renderGraph() {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('error').style.display = 'none';
            document.getElementById('graph').style.display = 'block';
            
            const graphElement = document.getElementById('graph');
            graphElement.innerHTML = '';
            
            if (revisions.length === 0) {
                graphElement.innerHTML = '<div class="loading">No revisions found</div>';
                return;
            }
            
            renderSimpleGraph(graphElement);
        }
        
        function renderSimpleGraph(container) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'graphSvg');
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
            svg.style.minHeight = '400px';
            
            const mainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            mainGroup.setAttribute('id', 'mainGroup');
            svg.appendChild(mainGroup);
            
            const nodeWidth = 180;
            const nodeHeight = 60;
            const levelHeight = 100;
            
            const levels = {};
            const maxLevel = revisions.length;
            
            revisions.forEach((revision, index) => {
                levels[revision.id] = maxLevel - index;
            });
            
            revisions.forEach((revision, index) => {
                const level = levels[revision.id];
                const defaultX = 50 + (index % 3) * (nodeWidth + 20);
                const defaultY = 50 + (level - 1) * levelHeight;
                
                // Use stored position or default position
                if (!nodePositions[revision.id]) {
                    nodePositions[revision.id] = { x: defaultX, y: defaultY };
                }
                const x = nodePositions[revision.id].x;
                const y = nodePositions[revision.id].y;
                
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                g.setAttribute('transform', \`translate(\${x}, \${y})\`);
                
                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('width', nodeWidth);
                rect.setAttribute('height', nodeHeight);
                rect.setAttribute('rx', '4');
                rect.setAttribute('class', 'node-rect');
                
                let className = 'node';
                if (revision.isCurrent) className += ' current';
                else if (revision.isHead) className += ' head';
                if (revision.isMerge) className += ' merge';
                if (!revision.isCurrent && !isApplied(revision)) className += ' unapplied';
                
                rect.setAttribute('fill', getNodeColor(revision));
                rect.setAttribute('stroke', getNodeBorderColor(revision));
                rect.setAttribute('stroke-width', '2');
                
                const idText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                idText.setAttribute('x', nodeWidth / 2);
                idText.setAttribute('y', 20);
                idText.setAttribute('text-anchor', 'middle');
                idText.setAttribute('font-family', 'monospace');
                idText.setAttribute('font-size', '12');
                idText.setAttribute('font-weight', 'bold');
                idText.setAttribute('fill', 'var(--vscode-editor-foreground)');
                idText.textContent = revision.shortId;
                
                const messageText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                messageText.setAttribute('x', nodeWidth / 2);
                messageText.setAttribute('y', 40);
                messageText.setAttribute('text-anchor', 'middle');
                messageText.setAttribute('font-size', '10');
                messageText.setAttribute('fill', 'var(--vscode-descriptionForeground)');
                messageText.textContent = revision.message.length > 20 ? 
                    revision.message.substring(0, 20) + '...' : revision.message;
                
                g.appendChild(rect);
                g.appendChild(idText);
                g.appendChild(messageText);
                
                g.addEventListener('click', (e) => handleNodeClick(e, revision));
                g.addEventListener('contextmenu', (e) => showContextMenu(e, revision));
                g.addEventListener('mousedown', (e) => handleNodeDragStart(e, revision));
                g.style.cursor = 'pointer';
                g.setAttribute('data-revision-id', revision.id);
                
                mainGroup.appendChild(g);
                
                if (revision.downRevision) {
                    const parentIndex = revisions.findIndex(r => r.id === revision.downRevision);
                    if (parentIndex !== -1) {
                        const parentPos = nodePositions[revision.downRevision];
                        const parentX = parentPos.x + nodeWidth / 2;
                        const parentY = parentPos.y;
                        const childX = x + nodeWidth / 2;
                        const childY = y + nodeHeight;
                        
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                        line.setAttribute('x1', parentX);
                        line.setAttribute('y1', parentY);
                        line.setAttribute('x2', childX);
                        line.setAttribute('y2', childY);
                        line.setAttribute('stroke', 'var(--vscode-panel-border)');
                        line.setAttribute('stroke-width', '2');
                        line.setAttribute('marker-end', 'url(#arrowhead)');
                        line.setAttribute('data-parent', revision.downRevision);
                        line.setAttribute('data-child', revision.id);
                        
                        mainGroup.insertBefore(line, g);
                    }
                }
            });
            
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            marker.setAttribute('id', 'arrowhead');
            marker.setAttribute('markerWidth', '10');
            marker.setAttribute('markerHeight', '7');
            marker.setAttribute('refX', '9');
            marker.setAttribute('refY', '3.5');
            marker.setAttribute('orient', 'auto');
            
            const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
            polygon.setAttribute('fill', 'var(--vscode-panel-border)');
            
            marker.appendChild(polygon);
            defs.appendChild(marker);
            svg.appendChild(defs);
            
            setupPanZoom(svg);
            updateTransform();
            
            container.appendChild(svg);
        }
        
        function getNodeColor(revision) {
            if (revision.isCurrent) return 'var(--vscode-button-background)';
            if (revision.isHead) return 'var(--vscode-gitDecoration-modifiedResourceForeground)';
            return 'var(--vscode-editor-background)';
        }
        
        function getNodeBorderColor(revision) {
            if (revision.isCurrent) return 'var(--vscode-button-background)';
            if (revision.isHead) return 'var(--vscode-gitDecoration-modifiedResourceForeground)';
            return 'var(--vscode-panel-border)';
        }
        
        function isApplied(revision) {
            return revision.isCurrent || revisions.some(r => r.isCurrent && isAncestor(revision, r));
        }
        
        function isAncestor(ancestor, descendant) {
            let current = descendant;
            while (current && current.downRevision) {
                if (current.downRevision === ancestor.id) return true;
                current = revisions.find(r => r.id === current.downRevision);
            }
            return false;
        }
        
        function handleNodeClick(event, revision) {
            // Don't handle clicks if we just finished dragging
            if (isDragging || justFinishedDragging) return;
            
            console.log('handleNodeClick called', { 
                modifyMode, 
                selectedNodeId: selectedNode ? selectedNode.id : null, 
                selectedNodeShortId: selectedNode ? selectedNode.shortId : null,
                clickedRevisionId: revision.id,
                clickedRevisionShortId: revision.shortId,
                areEqual: selectedNode ? selectedNode.id === revision.id : false
            });
            event.preventDefault();
            event.stopPropagation();
            
            // Small delay to ensure this isn't called multiple times rapidly
            setTimeout(() => {
                if (!modifyMode) {
                    console.log('Not in modify mode - opening file');
                    openRevisionFile(revision.id);
                    return;
                }
                
                if (selectedNode === null) {
                    console.log('Selecting first node:', revision.shortId);
                    selectedNode = revision;
                    highlightNode(revision.id, true);
                    showMessage(\`Selected \${revision.shortId}. Now click on the new parent revision.\`);
                } else if (selectedNode.id !== revision.id) {
                    console.log('Setting new parent:', selectedNode.shortId, '->', revision.shortId);
                    console.log('Sending modifyDependency message');
                    vscode.postMessage({
                        type: 'modifyDependency',
                        revisionId: selectedNode.id,
                        newParent: revision.id
                    });
                    highlightNode(selectedNode.id, false);
                    selectedNode = null;
                    showMessage('Dependency modification requested...');
                } else {
                    console.log('Clearing selection - same node clicked');
                    highlightNode(selectedNode.id, false);
                    selectedNode = null;
                    showMessage('Selection cleared.');
                }
            }, 10);
        }
        
        function highlightNode(revisionId, highlight) {
            const nodes = document.querySelectorAll('g');
            nodes.forEach(node => {
                const idText = node.querySelector('text');
                if (idText && idText.textContent === revisionId.substring(0, 8)) {
                    const rect = node.querySelector('rect');
                    if (highlight) {
                        rect.setAttribute('stroke', 'var(--vscode-focusBorder)');
                        rect.setAttribute('stroke-width', '4');
                    } else {
                        rect.setAttribute('stroke', getNodeBorderColor(revisions.find(r => r.id === revisionId)));
                        rect.setAttribute('stroke-width', '2');
                    }
                }
            });
        }
        
        function showMessage(text) {
            const messageDiv = document.createElement('div');
            messageDiv.style.position = 'fixed';
            messageDiv.style.top = '10px';
            messageDiv.style.left = '50%';
            messageDiv.style.transform = 'translateX(-50%)';
            messageDiv.style.backgroundColor = 'var(--vscode-notifications-background)';
            messageDiv.style.color = 'var(--vscode-notifications-foreground)';
            messageDiv.style.padding = '8px 16px';
            messageDiv.style.borderRadius = '4px';
            messageDiv.style.border = '1px solid var(--vscode-notifications-border)';
            messageDiv.style.zIndex = '1001';
            messageDiv.textContent = text;
            
            document.body.appendChild(messageDiv);
            
            setTimeout(() => {
                if (messageDiv.parentNode) {
                    messageDiv.parentNode.removeChild(messageDiv);
                }
            }, 3000);
        }

        function openRevisionFile(revisionId) {
            vscode.postMessage({
                type: 'openRevisionFile',
                revisionId: revisionId
            });
            hideContextMenu();
        }
        
        function showContextMenu(event, revision) {
            event.preventDefault();
            
            const menu = document.getElementById('contextMenu');
            menu.innerHTML = '';
            
            const menuItems = [
                { text: 'Open File', action: () => openRevisionFile(revision.id) },
                { text: 'Upgrade to This', action: () => upgradeToRevision(revision.id) },
                { text: 'Downgrade to This', action: () => downgradeToRevision(revision.id) },
                { text: 'Stamp This', action: () => stampRevision(revision.id) }
            ];
            
            menuItems.forEach(item => {
                const menuItem = document.createElement('div');
                menuItem.className = 'context-menu-item';
                menuItem.textContent = item.text;
                menuItem.addEventListener('click', item.action);
                menu.appendChild(menuItem);
            });
            
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
            menu.style.display = 'block';
            
            document.addEventListener('click', hideContextMenu, { once: true });
        }
        
        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
        }
        
        function upgradeToRevision(revisionId) {
            vscode.postMessage({
                type: 'upgradeToRevision',
                revisionId: revisionId
            });
        }
        
        function downgradeToRevision(revisionId) {
            vscode.postMessage({
                type: 'downgradeToRevision',
                revisionId: revisionId
            });
        }
        
        function stampRevision(revisionId) {
            vscode.postMessage({
                type: 'stampRevision',
                revisionId: revisionId
            });
        }

        function upgradeToHead() {
            vscode.postMessage({
                type: 'upgradeToRevision',
                revisionId: 'head'
            });
        }
        
        function toggleModifyMode() {
            modifyMode = !modifyMode;
            const btn = document.getElementById('modifyBtn');
            btn.textContent = modifyMode ? 'Exit Modify Mode' : 'Modify Dependencies';
            btn.style.backgroundColor = modifyMode ? 'var(--vscode-errorBackground)' : '';
            
            if (!modifyMode && selectedNode) {
                highlightNode(selectedNode.id, false);
                selectedNode = null;
            }
            
            if (modifyMode) {
                showMessage('Modify mode enabled. Click on a revision to select it, then click on its new parent revision.');
            } else {
                showMessage('Modify mode disabled.');
            }
        }
        
        function refresh() {
            vscode.postMessage({ type: 'ready' });
        }
        
        function updateRefreshStatus(message) {
            const statusElement = document.getElementById('refreshStatus');
            if (statusElement) {
                statusElement.textContent = message;
                statusElement.style.color = 'var(--vscode-charts-green)';
                
                // Fade back to normal color after 3 seconds
                setTimeout(() => {
                    statusElement.style.color = 'var(--vscode-descriptionForeground)';
                    statusElement.textContent = 'Auto-refresh enabled';
                }, 3000);
            }
        }
        
        function setupPanZoom(svg) {
            svg.addEventListener('mousedown', handlePanStart);
            svg.addEventListener('mousemove', handlePanMove);
            svg.addEventListener('mouseup', handlePanEnd);
            svg.addEventListener('mouseleave', handlePanEnd);
            svg.addEventListener('wheel', handleZoom);
            
            // Add global drag handlers
            svg.addEventListener('mousemove', handleNodeDragMove);
            svg.addEventListener('mouseup', handleNodeDragEnd);
        }
        
        function handlePanStart(event) {
            console.log('handlePanStart', event.target.tagName, event.target.id, event.button);
            if (event.button === 0 && (event.target.tagName === 'svg' || event.target.id === 'graphSvg') && !isDragging) {
                console.log('Starting pan');
                isPanning = true;
                panStart.x = event.clientX;
                panStart.y = event.clientY;
                event.target.classList.add('panning');
                event.preventDefault();
            }
        }
        
        function handlePanMove(event) {
            if (isPanning) {
                const deltaX = event.clientX - panStart.x;
                const deltaY = event.clientY - panStart.y;
                
                currentTransform.x += deltaX;
                currentTransform.y += deltaY;
                
                panStart.x = event.clientX;
                panStart.y = event.clientY;
                
                updateTransform();
                event.preventDefault();
            }
        }
        
        function handlePanEnd(event) {
            if (isPanning) {
                isPanning = false;
                event.target.classList.remove('panning');
            }
        }
        
        function handleZoom(event) {
            event.preventDefault();
            
            const scaleFactor = event.deltaY > 0 ? 0.9 : 1.1;
            const newScale = currentTransform.scale * scaleFactor;
            
            if (newScale >= 0.1 && newScale <= 5) {
                const rect = event.target.getBoundingClientRect();
                const mouseX = event.clientX - rect.left;
                const mouseY = event.clientY - rect.top;
                
                currentTransform.x = mouseX - (mouseX - currentTransform.x) * scaleFactor;
                currentTransform.y = mouseY - (mouseY - currentTransform.y) * scaleFactor;
                currentTransform.scale = newScale;
                
                updateTransform();
            }
        }
        
        function updateTransform() {
            const mainGroup = document.getElementById('mainGroup');
            if (mainGroup) {
                mainGroup.setAttribute('transform', 
                    \`translate(\${currentTransform.x}, \${currentTransform.y}) scale(\${currentTransform.scale})\`);
            }
        }
        
        function handleNodeDragStart(event, revision) {
            if (event.button === 0 && !modifyMode) {
                event.preventDefault();
                event.stopPropagation();
                isDragging = true;
                dragNode = revision;
                actuallyDragged = false;
                
                const svg = document.getElementById('graphSvg');
                const svgRect = svg.getBoundingClientRect();
                
                // Get the actual SVG coordinate using SVG methods
                const svgPoint = svg.createSVGPoint();
                svgPoint.x = event.clientX;
                svgPoint.y = event.clientY;
                
                // Transform to the main group's coordinate system
                const mainGroup = document.getElementById('mainGroup');
                const ctm = mainGroup.getScreenCTM().inverse();
                const transformedPoint = svgPoint.matrixTransform(ctm);
                
                console.log('Drag start:', {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    transformedX: transformedPoint.x,
                    transformedY: transformedPoint.y,
                    nodeX: nodePositions[revision.id].x,
                    nodeY: nodePositions[revision.id].y,
                    scale: currentTransform.scale
                });
                
                // Store the offset from the node position to the mouse
                dragStart.x = transformedPoint.x - nodePositions[revision.id].x;
                dragStart.y = transformedPoint.y - nodePositions[revision.id].y;
                
                event.currentTarget.style.cursor = 'grabbing';
            }
        }
        
        function handleNodeDragMove(event) {
            if (isDragging && dragNode) {
                event.preventDefault();
                
                const svg = document.getElementById('graphSvg');
                
                // Get the actual SVG coordinate using SVG methods
                const svgPoint = svg.createSVGPoint();
                svgPoint.x = event.clientX;
                svgPoint.y = event.clientY;
                
                // Transform to the main group's coordinate system
                const mainGroup = document.getElementById('mainGroup');
                const ctm = mainGroup.getScreenCTM().inverse();
                const transformedPoint = svgPoint.matrixTransform(ctm);
                
                // Update node position using the stored offset
                nodePositions[dragNode.id].x = transformedPoint.x - dragStart.x;
                nodePositions[dragNode.id].y = transformedPoint.y - dragStart.y;
                
                console.log('Drag move:', {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    transformedX: transformedPoint.x,
                    transformedY: transformedPoint.y,
                    newNodeX: nodePositions[dragNode.id].x,
                    newNodeY: nodePositions[dragNode.id].y
                });
                
                // Mark that actual dragging occurred
                actuallyDragged = true;
                
                // Update only the dragged node and its connections without full re-render
                updateNodePosition(dragNode.id, nodePositions[dragNode.id].x, nodePositions[dragNode.id].y);
            }
        }
        
        function updateNodePosition(nodeId, newX, newY) {
            const nodeElement = document.querySelector(\`[data-revision-id="\${nodeId}"]\`);
            if (nodeElement) {
                nodeElement.setAttribute('transform', \`translate(\${newX}, \${newY})\`);
                
                // Update all lines connected to this node
                updateConnectedLines(nodeId);
            }
        }
        
        function updateConnectedLines(nodeId) {
            const nodeWidth = 180;
            const nodeHeight = 60;
            
            // Update lines where this node is the parent (lines going FROM this node)
            revisions.forEach(revision => {
                if (revision.downRevision === nodeId) {
                    const line = document.querySelector(\`line[data-parent="\${nodeId}"][data-child="\${revision.id}"]\`);
                    if (line) {
                        const parentPos = nodePositions[nodeId];
                        const childPos = nodePositions[revision.id];
                        if (parentPos && childPos) {
                            line.setAttribute('x1', parentPos.x + nodeWidth / 2);
                            line.setAttribute('y1', parentPos.y);
                            line.setAttribute('x2', childPos.x + nodeWidth / 2);
                            line.setAttribute('y2', childPos.y + nodeHeight);
                        }
                    }
                }
            });
            
            // Update lines where this node is the child (lines going TO this node)
            const thisRevision = revisions.find(r => r.id === nodeId);
            if (thisRevision && thisRevision.downRevision) {
                const line = document.querySelector(\`line[data-parent="\${thisRevision.downRevision}"][data-child="\${nodeId}"]\`);
                if (line) {
                    const parentPos = nodePositions[thisRevision.downRevision];
                    const childPos = nodePositions[nodeId];
                    if (parentPos && childPos) {
                        line.setAttribute('x1', parentPos.x + nodeWidth / 2);
                        line.setAttribute('y1', parentPos.y);
                        line.setAttribute('x2', childPos.x + nodeWidth / 2);
                        line.setAttribute('y2', childPos.y + nodeHeight);
                    }
                }
            }
        }
        
        function handleNodeDragEnd(event) {
            if (isDragging) {
                isDragging = false;
                
                // Only prevent clicks if we actually dragged (moved the node)
                if (actuallyDragged) {
                    justFinishedDragging = true;
                    
                    // Clear the flag after a short delay to allow click events to be ignored
                    setTimeout(() => {
                        justFinishedDragging = false;
                    }, 100);
                }
                
                if (dragNode) {
                    const draggedElement = document.querySelector(\`[data-revision-id="\${dragNode.id}"]\`);
                    if (draggedElement) {
                        draggedElement.style.cursor = 'pointer';
                    }
                }
                dragNode = null;
                actuallyDragged = false;
            }
        }
    </script>
</body>
</html>`;
    }
}