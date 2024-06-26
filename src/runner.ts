// Released under the MIT License.
// Copyright, 2023, by Samuel Williams.

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as ndjson from 'ndjson';

import {loadEnvironment} from './environment';

export interface Tests {[key: string]: vscode.TestItem}

function openHost(root: string, env: any = {}) {
	return child_process.spawn("bundle", ["exec", "sus-host"], {shell: true, stdio: 'pipe', cwd: root, env});
}

export class FileCoverage extends vscode.FileCoverage {
	details: vscode.FileCoverageDetail[];
	
	constructor(uri: vscode.Uri, details: vscode.FileCoverageDetail[]) {
		const coverage = vscode.FileCoverage.fromDetails(uri, details);
		super(uri, coverage.statementCoverage, coverage.branchCoverage, coverage.declarationCoverage);
		this.details = details;
	}
}

export class Runner implements vscode.Disposable {
	testRun: vscode.TestRun;
	workspaceFolder: vscode.WorkspaceFolder;
	tests: Tests;
	
	child: child_process.ChildProcess;
	output: any;
	
	finished: Promise<void>;
	
	static async open(testRun: vscode.TestRun, workspaceFolder: vscode.WorkspaceFolder, tests: Tests, cancellation: vscode.CancellationToken | undefined) {
		const env = await loadEnvironment(workspaceFolder.uri.fsPath);
		
		env.COVERAGE = 'Quiet';
		
		const child = openHost(workspaceFolder.uri.fsPath, env);
		
		cancellation?.onCancellationRequested(() => {
			child.kill();
		});
		
		return new this(testRun, workspaceFolder, tests, child);
	}
	
	constructor(testRun: vscode.TestRun, workspaceFolder: vscode.WorkspaceFolder, tests: Tests, child: child_process.ChildProcess) {
		this.testRun = testRun;
		this.workspaceFolder = workspaceFolder;
		this.tests = tests;
		
		this.child = child;
		
		this.child.stderr?.on('data', (data: Buffer) => {
			this.appendOutput(data.toString());
		});
		
		this.child.stdout?.pipe(ndjson.parse()).on('data', this.onData.bind(this));
		this.output = ndjson.stringify();
		this.output.on('data', (line: string) => this.child.stdin?.write(line));
		
		this.child.on('error', (error: Error) => {
			this.appendOutput(error.message);
		});
		
		this.finished = new Promise((resolve, reject) => {
			this.child.on('exit', (code: number) => {
				console.log("Test host exited with code", code);
				this.appendOutput(`Test host exited with code ${code}\r\n`);
				if (code == 0) {
					resolve();
				} else {
					reject(new Error(`Test host exited with code ${code}`));
				}
			});
		});
		
		// Kick off the test run:
		this.output.write({run: Object.keys(this.tests)});
	}
	
	appendOutput(text: string) {
		const lines = text.split(/\r?\n/);
		this.testRun.appendOutput(lines.join("\r\n"));
	}
	
	dispose() {
		this.child.kill();
	}
	
	messageBodyFor(data: any) {
		if (data.text) {
			return data.text;
		}
		// else if (data.markdownBody) {
		// 	return new vscode.MarkdownString(data.markdownBody);
		// }
	}
	
	locationFor(data: any) : vscode.Location | undefined {
		if (data.location) {
			return new vscode.Location(
				vscode.Uri.file(data.location.path),
				new vscode.Position(data.location.line - 1, data.location.column || 0)
			);
		}
	}
	
	messageFor(data: any) : vscode.TestMessage {
		const body = this.messageBodyFor(data);
		
		let message = null;
		
		if (data.actual && data.expected) {
			message = vscode.TestMessage.diff(body, data.actual, data.expected);
		} else {
			message = new vscode.TestMessage(body);
		}
		
		message.location = this.locationFor(data);
		
		return message;
	}
	
	messagesFor(data: any) : vscode.TestMessage[] {
		if (data.message) {
			return [this.messageFor(data.message)];
		}
		else if (data.messages) {
			return data.messages.map(this.messageFor.bind(this));
		} else {
			return [];
		}
	}
	
	popTest(identity: string) {
		const test = this.tests[identity];
		delete this.tests[identity];
		return test;
	}
	
	skipRemainingTests() {
		for (const identity in this.tests) {
			this.testRun.skipped(this.tests[identity]);
		}
	}
	
	addCoverage(data: any) {
		const uri = vscode.Uri.file(data.coverage);
		const statementCoverage: vscode.StatementCoverage[] = [];
		
		for (let lineNumber = 0; lineNumber < data.counts.length; lineNumber++) {
			const count = data.counts[lineNumber];
			if (count != null) {
				statementCoverage.push(new vscode.StatementCoverage(count, new vscode.Position(lineNumber - 1, 0)));
			}
		}
		
		this.testRun.addCoverage(new FileCoverage(uri, statementCoverage));
	}
	
	inform(data: any) {
		const test = this.tests[data.inform];
		
		this.messagesFor(data).forEach(message => {
			this.testRun.appendOutput(message.message.toString(), message.location, test);
		});
	}
	
	onData(data: any) {
		if (data.started) {
			this.testRun.started(this.tests[data.started]);
		}
		else if (data.inform) {
			this.inform(data);
		}
		else if (data.passed) {
			this.testRun.passed(this.popTest(data.passed), data.duration);
		}
		else if (data.failed) {
			this.testRun.failed(this.popTest(data.failed), this.messagesFor(data), data.duration);
		}
		else if (data.errored) {
			this.testRun.errored(this.popTest(data.errored), this.messagesFor(data), data.duration);
		}
		else if (data.finished) {
			this.appendOutput(data.message);
			this.child.stdin?.end();
		}
		else if (data.coverage) {
			this.addCoverage(data);
		}
	}
	
	async run() {
		this.appendOutput(`Running tests in ${this.workspaceFolder.name}...\r\n`);
		try {
			await this.finished;
		} catch (error: any) {
			console.log("await this.finished", error);
		} finally {
			this.skipRemainingTests();
			this.testRun.end();
		}
	}
}
