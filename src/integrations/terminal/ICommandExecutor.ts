import { ClineToolResponseContent } from "@shared/messages"

/**
 * Interface for command executors.
 * Implementations handle the execution of shell commands in different terminal modes.
 */
export interface ICommandExecutor {
	/**
	 * Execute a command in the terminal
	 * @param command The command to execute
	 * @param timeoutSeconds Optional timeout in seconds
	 * @returns [userRejected, result] tuple
	 */
	execute(command: string, timeoutSeconds: number | undefined): Promise<[boolean, ClineToolResponseContent]>

	/**
	 * Cancel the currently running background command
	 * @returns true if a command was cancelled, false otherwise
	 */
	cancelBackgroundCommand(): Promise<boolean>

	/**
	 * Check if there's an active background command
	 */
	hasActiveBackgroundCommand(): boolean

	/**
	 * Get the active background command info (for external access)
	 */
	getActiveBackgroundCommand(): ActiveBackgroundCommand | undefined
}

/**
 * Represents an active background command that can be cancelled
 */
export interface ActiveBackgroundCommand {
	process: {
		terminate?: () => void
		continue?: () => void
	}
	command: string
	outputLines: string[]
}

/**
 * Callbacks for CommandExecutor to interact with Task state
 * These are bound methods from the Task class that allow CommandExecutor
 * to update UI and state without owning that state directly.
 */
export interface CommandExecutorCallbacks {
	/** Display a message in the chat UI */
	say: (type: string, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	/** Update the background command running state in the controller */
	updateBackgroundCommandState: (running: boolean) => void
	/** Update a cline message by index */
	updateClineMessage: (index: number, updates: { commandCompleted?: boolean }) => Promise<void>
	/** Get cline messages array */
	getClineMessages: () => Array<{ ask?: string; say?: string }>
	/** Add content to user message for next API request */
	addToUserMessageContent: (content: { type: string; text: string }) => void
	/** Get the current ask response state */
	getAskResponse: () => string | undefined
	/** Clear the ask response state */
	clearAskResponse: () => void
}

/**
 * Base configuration for CommandExecutor
 */
export interface CommandExecutorConfig {
	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	cwd: string
	taskId: string
	ulid: string
	standaloneTerminalModulePath: string
}
