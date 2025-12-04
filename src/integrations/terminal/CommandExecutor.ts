import { ClineToolResponseContent } from "@shared/messages"

import { BackgroundCommandExecutor, BackgroundCommandExecutorConfig } from "./backgroundCommand/BackgroundCommandExecutor"
import { BackgroundCommandTracker } from "./backgroundCommand/BackgroundCommandTracker"
import { ActiveBackgroundCommand, CommandExecutorCallbacks, CommandExecutorConfig, ICommandExecutor } from "./ICommandExecutor"
import { TerminalManager } from "./vscode/TerminalManager"
import { VscodeCommandExecutor, VscodeCommandExecutorConfig } from "./vscode/VscodeCommandExecutor"

/**
 * Full configuration for CommandExecutor factory
 * Includes all fields needed by both VSCode and Background executors
 */
export interface FullCommandExecutorConfig extends CommandExecutorConfig {
	terminalManager: TerminalManager
	backgroundCommandTracker: BackgroundCommandTracker | undefined
}

// Re-export types for convenience
export type { CommandExecutorCallbacks, CommandExecutorConfig, ICommandExecutor } from "./ICommandExecutor"

/**
 * CommandExecutor - Factory/Delegator Pattern
 *
 * This class acts as a factory that creates the appropriate command executor
 * based on the terminal execution mode:
 *
 * - "vscodeTerminal" mode: Uses VscodeCommandExecutor
 *   - VSCode's integrated terminal with shell integration
 *   - Commands run to completion (blocking)
 *   - Real-time output streaming to chat UI
 *
 * - "backgroundExec" mode: Uses BackgroundCommandExecutor
 *   - Standalone/CLI mode with detached processes
 *   - Supports "Proceed While Running" with background tracking
 *   - Output logged to temp files
 *   - 10-minute hard timeout protection
 *   - Command cancellation support
 *
 * The factory pattern allows Task class to use a single interface while
 * the actual implementation is selected at construction time based on mode.
 */
export class CommandExecutor implements ICommandExecutor {
	private delegate: ICommandExecutor

	constructor(config: FullCommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		if (config.terminalExecutionMode === "backgroundExec") {
			// Standalone/CLI mode - use BackgroundCommandExecutor
			const backgroundConfig: BackgroundCommandExecutorConfig = {
				terminalManager: config.terminalManager,
				backgroundCommandTracker: config.backgroundCommandTracker,
				terminalExecutionMode: config.terminalExecutionMode,
				cwd: config.cwd,
				taskId: config.taskId,
				ulid: config.ulid,
				standaloneTerminalModulePath: config.standaloneTerminalModulePath,
			}
			this.delegate = new BackgroundCommandExecutor(backgroundConfig, callbacks)
		} else {
			// VSCode terminal mode - use VscodeCommandExecutor
			const vscodeConfig: VscodeCommandExecutorConfig = {
				terminalManager: config.terminalManager,
				terminalExecutionMode: config.terminalExecutionMode,
				cwd: config.cwd,
				taskId: config.taskId,
				ulid: config.ulid,
				standaloneTerminalModulePath: config.standaloneTerminalModulePath,
			}
			this.delegate = new VscodeCommandExecutor(vscodeConfig, callbacks)
		}
	}

	/**
	 * Execute a command in the terminal
	 * Delegates to the appropriate executor based on mode
	 */
	execute(command: string, timeoutSeconds: number | undefined): Promise<[boolean, ClineToolResponseContent]> {
		return this.delegate.execute(command, timeoutSeconds)
	}

	/**
	 * Cancel the currently running background command
	 * Only supported in backgroundExec mode
	 */
	cancelBackgroundCommand(): Promise<boolean> {
		return this.delegate.cancelBackgroundCommand()
	}

	/**
	 * Check if there's an active background command
	 */
	hasActiveBackgroundCommand(): boolean {
		return this.delegate.hasActiveBackgroundCommand()
	}

	/**
	 * Get the active background command info
	 */
	getActiveBackgroundCommand(): ActiveBackgroundCommand | undefined {
		return this.delegate.getActiveBackgroundCommand()
	}
}
