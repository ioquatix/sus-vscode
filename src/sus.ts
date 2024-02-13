// Released under the MIT License.
// Copyright, 2023, by Samuel Williams.

import * as vscode from 'vscode';

import {Tree, Node, loadTreeFromPath} from './tree';
import {Tests, Runner} from './runner';

class RunRequest {
	workspaceFolder: vscode.WorkspaceFolder;
	request: vscode.TestRunRequest;
	cancellationToken: vscode.CancellationToken;
	
	treeUpdated: vscode.EventEmitter<Tree> = new vscode.EventEmitter<Tree>();
	onTreeUpdated: vscode.Event<Tree> = this.treeUpdated.event;
	
	constructor(workspaceFolder: vscode.WorkspaceFolder, request: vscode.TestRunRequest, cancellationToken: vscode.CancellationToken) {
		this.workspaceFolder = workspaceFolder;
		this.request = request;
		this.cancellationToken = cancellationToken;
	}
	
	async run(identifier: string, controller: vscode.TestController) {
		if (this.request.continuous) {
			for (;;) {
				const treeUpdated: Promise<Tree> = new Promise((resolve, reject) => {
					this.onTreeUpdated(resolve);
					this.cancellationToken.onCancellationRequested(reject);
				});
				
				await this.runOnce(identifier, controller);
				
				// Wait for the tree to be updated or cancelled:
				await treeUpdated;
			}
		} else {
			await this.runOnce(identifier, controller);
		}
	}
	
	async runOnce(identifier: string, controller: vscode.TestController) {
		const testRun = controller.createTestRun(this.request, identifier, true);
		const items = this.request.include ?? controller.items;
		const tests: Tests = {};
		
		function add(items: readonly vscode.TestItem[] | vscode.TestItemCollection) {
			items.forEach(item => {
				if (item.children.size > 0) add(item.children);
				else tests[item.id] = item;
			});
		}
		
		add(items);
		
		function remove(items: readonly vscode.TestItem[] | vscode.TestItemCollection) {
			items.forEach(item => {
				delete tests[item.id];
				if (item.children) remove(item.children);
			});
		}
		
		if (this.request.exclude) {
			remove(this.request.exclude);
		}
		
		const runner = new Runner(testRun, this.workspaceFolder, tests, this.cancellationToken);
		
		try {
			await runner.run();
		} finally {
			runner.dispose();
		}
	}
}

export class Project implements vscode.Disposable {
	workspaceFolder: vscode.WorkspaceFolder;
	controller: vscode.TestController;
	
	watcher: vscode.FileSystemWatcher | undefined;
	runRequests: Set<RunRequest> = new Set();
	
	constructor(workspaceFolder: vscode.WorkspaceFolder, controller: vscode.TestController) {
		this.workspaceFolder = workspaceFolder;
		this.controller = controller;
	}
	
	dispose() {
		this.controller.dispose();
		this.watcher?.dispose();
	}
	
	addNodes(nodes: Node[], parent: vscode.TestItemCollection) {
		const stale: Set<string> = new Set();
		parent.forEach(item => stale.add(item.id));
		
		for (const node of nodes) {
			let testItem = parent.get(node.identity);
			
			if (!testItem || testItem.description !== node.description) {
				testItem = this.addNode(node, parent);
			}
			
			stale.delete(testItem.id);
			
			this.addNodes(node.children, testItem.children);
		}
		
		// Remove stale test items:
		for (const id of stale) {
			parent.delete(id);
		}
	}
	
	addNode(node: Node, parent: vscode.TestItemCollection) {
		const parts = node.identity.split(':');
		const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, parts[0]);
		const item = this.controller.createTestItem(node.identity, node.description, uri);
		
		if (parts.length > 1) {
			const lineNumber = parseInt(parts[parts.length - 1]);
			
			item.range = new vscode.Range(
				new vscode.Position(lineNumber - 1, 0),
				new vscode.Position(lineNumber, 0)
			);
		}
		
		parent.add(item);
		
		return item;
	}
	
	async updateTree(tree: Tree) {
		// Don't add the root node as it's basically a place-holder.
		this.addNodes(tree.root.children, this.controller.items);
	}
	
	async loadTree() {
		const tree = await loadTreeFromPath(this.workspaceFolder.uri.fsPath);
		
		this.updateTree(tree);
		
		// Notify all the runRequests that the tree has been updated:
		for (const runRequest of this.runRequests) {
			runRequest.treeUpdated.fire(tree);
		}
	}
	
	prepareWatcher() {
		const pattern = new vscode.RelativePattern(this.workspaceFolder, '**/*.rb');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		
		watcher.onDidCreate(uri => this.loadTree());
		watcher.onDidChange(uri => this.loadTree());
		watcher.onDidDelete(uri => this.loadTree());
		
		return watcher;
	}
	
	async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
		const runRequest = new RunRequest(this.workspaceFolder, request, token);
		const identifier = this.workspaceFolder.uri.toString();
		
		this.runRequests.add(runRequest);
		
		try {
			await runRequest.run(identifier, this.controller);
		} finally {
			this.runRequests.delete(runRequest);
		}
	}
	
	resolveTree(test: vscode.TestItem | undefined) {
		this.loadTree();
	}
	
	async setup() {
		await this.loadTree();
		this.watcher = this.prepareWatcher();
		
		this.controller.refreshHandler = this.loadTree.bind(this);
		this.controller.resolveHandler = this.resolveTree.bind(this);
		
		this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, this.runHandler.bind(this), true, undefined, true);
		this.controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, this.runHandler.bind(this), true, undefined, true);
	}
}
