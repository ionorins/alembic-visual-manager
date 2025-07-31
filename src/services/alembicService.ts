import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';

export interface RevisionInfo {
    id: string;
    shortId: string;
    message: string;
    branchLabels: string[];
    downRevision: string | null;
    isCurrent: boolean;
    isHead: boolean;
    isMerge: boolean;
    author?: string;
    date?: string;
}

export class AlembicService {
    private outputChannel: vscode.OutputChannel;
    private workspaceRoot: string;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Alembic');
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    }

    private getConfig() {
        const config = vscode.workspace.getConfiguration('alembic');
        return {
            scriptPath: config.get<string>('scriptPath', 'python'),
            customArgs: config.get<string[]>('customArgs', [])
        };
    }

    private async runAlembicCommand(args: string[]): Promise<string> {
        const config = this.getConfig();
        const fullArgs = ['-m', 'alembic', ...args];
        
        if (config.customArgs.length > 0) {
            config.customArgs.forEach(arg => {
                fullArgs.push('-x', arg);
            });
        }

        return new Promise((resolve, reject) => {
            const process = spawn(config.scriptPath, fullArgs, {
                cwd: this.workspaceRoot + '/backend',
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
            });

            process.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                this.outputChannel.append(output);
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Alembic command failed: ${stderr || stdout}`));
                }
            });

            process.on('error', (error) => {
                reject(error);
            });
        });
    }

    async getHistory(): Promise<RevisionInfo[]> {
        try {
            const historyOutput = await this.runAlembicCommand(['history', '--verbose', '--indicate-current']);
            const currentOutput = await this.runAlembicCommand(['current']);
            const headsOutput = await this.runAlembicCommand(['heads']);

            const currentRevisions = this.parseCurrentRevisions(currentOutput);
            const headRevisions = this.parseHeadRevisions(headsOutput);
            
            return this.parseHistory(historyOutput, currentRevisions, headRevisions);
        } catch (error) {
            throw new Error(`Failed to get Alembic history: ${error}`);
        }
    }

    private parseHistory(output: string, currentRevisions: string[], headRevisions: string[]): RevisionInfo[] {
        const revisions: RevisionInfo[] = [];
        const lines = output.split('\n');
        let currentRevision: Partial<RevisionInfo> = {};
        let messageLines: string[] = [];
        let inMessage = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            
            if (trimmedLine.startsWith('Rev:')) {
                if (currentRevision.id) {
                    if (messageLines.length > 0) {
                        currentRevision.message = messageLines.join('\n').trim();
                    }
                    revisions.push(this.completeRevisionInfo(currentRevision, currentRevisions, headRevisions));
                }
                
                currentRevision = {};
                messageLines = [];
                inMessage = false;
                
                const revMatch = trimmedLine.match(/Rev: ([a-f0-9]+)(.*)/);
                if (revMatch) {
                    currentRevision.id = revMatch[1];
                    currentRevision.shortId = revMatch[1].substring(0, 8);
                    
                    const statusPart = revMatch[2];
                    currentRevision.isCurrent = statusPart.includes('(current)');
                    currentRevision.isHead = statusPart.includes('(head)');
                    
                    const branchMatch = statusPart.match(/\(([^)]+)\)/g);
                    if (branchMatch) {
                        currentRevision.branchLabels = branchMatch
                            .map(match => match.slice(1, -1))
                            .filter(label => label !== 'current' && label !== 'head');
                    } else {
                        currentRevision.branchLabels = [];
                    }
                }
            } else if (trimmedLine.startsWith('Parent:')) {
                const parentMatch = trimmedLine.match(/Parent: ([a-f0-9]+|<base>)/);
                if (parentMatch) {
                    currentRevision.downRevision = parentMatch[1] === '<base>' ? null : parentMatch[1];
                }
            } else if (trimmedLine.startsWith('Path:')) {
                inMessage = false;
            } else if (trimmedLine.startsWith('Merge point:')) {
                currentRevision.isMerge = true;
            } else if (trimmedLine.startsWith('Revision ID:') || 
                      trimmedLine.startsWith('Revises:') || 
                      trimmedLine.startsWith('Create Date:')) {
                if (trimmedLine.startsWith('Create Date:')) {
                    const dateMatch = trimmedLine.match(/Create Date: (.+)/);
                    if (dateMatch) {
                        currentRevision.date = dateMatch[1];
                    }
                }
                inMessage = false;
            } else if (trimmedLine && !inMessage && !trimmedLine.startsWith('INFO ')) {
                inMessage = true;
                messageLines.push(trimmedLine);
            } else if (inMessage && trimmedLine && !trimmedLine.startsWith('INFO ')) {
                messageLines.push(trimmedLine);
            } else if (inMessage && !trimmedLine) {
                inMessage = false;
            }
        }

        if (currentRevision.id) {
            if (messageLines.length > 0) {
                currentRevision.message = messageLines.join('\n').trim();
            }
            revisions.push(this.completeRevisionInfo(currentRevision, currentRevisions, headRevisions));
        }

        return revisions.reverse();
    }

    private completeRevisionInfo(
        partial: Partial<RevisionInfo>,
        currentRevisions: string[],
        headRevisions: string[]
    ): RevisionInfo {
        return {
            id: partial.id || '',
            shortId: partial.shortId || '',
            message: partial.message || '',
            branchLabels: partial.branchLabels || [],
            downRevision: partial.downRevision || null,
            isCurrent: currentRevisions.includes(partial.id || ''),
            isHead: headRevisions.includes(partial.id || ''),
            isMerge: partial.isMerge || false,
            author: partial.author,
            date: partial.date
        };
    }

    private parseCurrentRevisions(output: string): string[] {
        const revisions: string[] = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            const match = line.match(/([a-f0-9]+)/);
            if (match) {
                revisions.push(match[1]);
            }
        }
        
        return revisions;
    }

    private parseHeadRevisions(output: string): string[] {
        const revisions: string[] = [];
        const lines = output.split('\n');
        
        for (const line of lines) {
            const match = line.match(/([a-f0-9]+)/);
            if (match) {
                revisions.push(match[1]);
            }
        }
        
        return revisions;
    }

    async createRevision(message: string, autogenerate: boolean = false): Promise<void> {
        const args = ['revision'];
        if (autogenerate) {
            args.push('--autogenerate');
        }
        args.push('-m', message);
        
        await this.runAlembicCommand(args);
    }

    async upgrade(target: string): Promise<void> {
        await this.runAlembicCommand(['upgrade', target]);
    }

    async downgrade(target: string): Promise<void> {
        await this.runAlembicCommand(['downgrade', target]);
    }

    async stamp(revision: string): Promise<void> {
        await this.runAlembicCommand(['stamp', revision]);
    }

    async getRevisionFilePath(revisionId: string): Promise<string | null> {
        try {
            const showOutput = await this.runAlembicCommand(['show', revisionId]);
            const pathMatch = showOutput.match(/Path: (.+)/);
            
            return pathMatch ? pathMatch[1] : null;
        } catch (error) {
            console.error('Failed to get revision file path:', error);
        }
        
        return null;
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}