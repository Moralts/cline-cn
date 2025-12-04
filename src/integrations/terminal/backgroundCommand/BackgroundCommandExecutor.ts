import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { Logger } from "@services/logging/Logger"
import { TerminalHangStage, telemetryService } from "@services/telemetry"
import { ClineToolResponseContent } from "@shared/messages"

import { ActiveBackgroundCommand, CommandExecutorCallbacks, CommandExecutorConfig, ICommandExecutor } from "../ICommandExecutor"
import { TerminalManager } from "../vscode/TerminalManager"
import { TerminalProcessResultPromise } from "../vscode/TerminalProcess"
import { BackgroundCommandTracker } from "./BackgroundCommandTracker"

/**
 * Background/Standalone-specific configuration for command executor
 */
export interface BackgroundCommandExecutorConfig extends CommandExecutorConfig {
	terminalManager: TerminalManager
	backgroundCommandTracker: BackgroundCommandTracker | undefined
	standaloneTerminalModulePath: string
}

// Chunked terminal output buffering constants
const CHUNK_LINE_COUNT = 20
const CHUNK_BYTE_SIZE = 2048 // 2KB
const CHUNK_DEBOUNCE_MS = 100
const BUFFER_STUCK_TIMEOUT_MS = 6000 // 6 seconds
const COMPLETION_TIMEOUT_MS = 6000 // 6 seconds

/**
 * BackgroundCommandExecutor - Standalone/CLI Mode
 *
 * Handles command execution using detached processes for standalone/CLI mode.
 * This executor:
 * - Uses StandaloneTerminalManager for detached process execution
 * - Supports "Proceed While Running" with background tracking
 * - Logs output to temp files for later retrieval
 * - Has 10-minute hard timeout protection via BackgroundCommandTracker
 * - Supports command cancellation
 *
 * NOTE: Command preprocessing (subagent detection, cd stripping) is handled
 * at the CommandExecutor factory level before reaching this method.
 *
 * Used when terminalExecutionMode === "backgroundExec" OR for subagent commands
 */
export class BackgroundCommandExecutor implements ICommandExecutor {
	private terminalManager: TerminalManager
	private backgroundCommandTracker: BackgroundCommandTracker | undefined
	private cwd: string
	private ulid: string
	private callbacks: CommandExecutorCallbacks

	// Track active background command for cancellation
	private activeBackgroundCommand?: {
		process: TerminalProcessResultPromise & {
			terminate?: () => void
		}
		command: string
		outputLines: string[]
	}

	constructor(config: BackgroundCommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.backgroundCommandTracker = config.backgroundCommandTracker
		this.cwd = config.cwd
		this.ulid = config.ulid
		this.callbacks = callbacks

		// Load StandaloneTerminalManager for background/standalone execution
		// This is the key difference from VscodeCommandExecutor - we use detached processes
		try {
			const { StandaloneTerminalManager } = require(config.standaloneTerminalModulePath) as {
				StandaloneTerminalManager: new () => TerminalManager
			}
			this.terminalManager = new StandaloneTerminalManager()
			Logger.info("BackgroundCommandExecutor: Using StandaloneTerminalManager")
		} catch (error) {
			// Fallback to regular TerminalManager if loading fails
			Logger.error("BackgroundCommandExecutor: Failed to load StandaloneTerminalManager, using fallback", error)
			this.terminalManager = config.terminalManager
		}

		// Copy settings from the provided terminalManager to ensure consistency
		this.terminalManager.setShellIntegrationTimeout(config.terminalManager["shellIntegrationTimeout"] || 4000)
		this.terminalManager.setTerminalReuseEnabled(config.terminalManager["terminalReuseEnabled"] ?? true)
		this.terminalManager.setTerminalOutputLineLimit(config.terminalManager["terminalOutputLineLimit"] || 500)
		this.terminalManager.setSubagentTerminalOutputLineLimit(config.terminalManager["subagentTerminalOutputLineLimit"] || 2000)
	}

	/**
	 * Execute a command in background/standalone mode
	 *
	 * NOTE: Command preprocessing (subagent detection, cd stripping) is handled
	 * at the CommandExecutor factory level before reaching this method.
	 *
	 * @param command The command to execute (already preprocessed)
	 * @param timeoutSeconds Optional timeout in seconds (triggers "Proceed While Running" behavior)
	 * @returns [userRejected, result] tuple
	 */
	async execute(command: string, timeoutSeconds: number | undefined): Promise<[boolean, ClineToolResponseContent]> {
		Logger.info("Executing command in background mode: " + command)

		const terminalInfo = await this.terminalManager.getOrCreateTerminal(this.cwd)
		terminalInfo.terminal.show()
		const process = this.terminalManager.runCommand(terminalInfo, command)

		// Track command execution
		this.callbacks.updateBackgroundCommandState(true)
		this.activeBackgroundCommand = { process: process as any, command, outputLines: [] }

		const clearCommandState = async () => {
			if (this.activeBackgroundCommand?.process !== process) {
				return
			}
			this.activeBackgroundCommand = undefined
			this.callbacks.updateBackgroundCommandState(false)

			// Mark the command message as completed
			const clineMessages = this.callbacks.getClineMessages()
			const lastCommandIndex = this.findLastIndex(clineMessages, (m) => m.ask === "command" || m.say === "command")
			if (lastCommandIndex !== -1) {
				await this.callbacks.updateClineMessage(lastCommandIndex, {
					commandCompleted: true,
				})
			}
		}

		process.once("completed", clearCommandState)
		process.once("error", clearCommandState)
		process.catch(() => {
			clearCommandState()
		})

		let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
		let didContinue = false

		// Create a promise that resolves when user clicks "Proceed While Running"
		let cleanupProceedCheck: (() => void) | undefined
		const proceedPromise = new Promise<"proceed">((resolve) => {
			// Note: This check is handled by the Task class through askResponse state
			// For now, we'll rely on the timeout/completion flow
			cleanupProceedCheck = () => {}
		})

		// Chunked terminal output buffering
		let outputBuffer: string[] = []
		let outputBufferSize: number = 0
		let chunkTimer: NodeJS.Timeout | null = null

		// Track if buffer gets stuck
		let bufferStuckTimer: NodeJS.Timeout | null = null

		const flushBuffer = async (force = false) => {
			if (outputBuffer.length === 0 && !force) {
				return
			}
			const chunk = outputBuffer.join("\n")
			outputBuffer = []
			outputBufferSize = 0

			if (!didContinue) {
				// Start timer to detect if buffer gets stuck
				bufferStuckTimer = setTimeout(() => {
					telemetryService.captureTerminalHang(TerminalHangStage.BUFFER_STUCK)
					bufferStuckTimer = null
				}, BUFFER_STUCK_TIMEOUT_MS)

				// Use say() to stream output without blocking
				await this.callbacks.say("command_output", chunk)

				// Clear the stuck timer since we successfully sent output
				if (bufferStuckTimer) {
					clearTimeout(bufferStuckTimer)
					bufferStuckTimer = null
				}
			} else {
				// After "Proceed While Running" in background mode: DON'T stream to UI
				// Output is being logged to temp file by BackgroundCommandTracker
			}
		}

		const scheduleFlush = () => {
			if (chunkTimer) {
				clearTimeout(chunkTimer)
			}
			chunkTimer = setTimeout(async () => await flushBuffer(), CHUNK_DEBOUNCE_MS)
		}

		const outputLines: string[] = []
		process.on("line", async (line) => {
			outputLines.push(line)

			// Track output in activeBackgroundCommand for cancellation
			if (this.activeBackgroundCommand) {
				this.activeBackgroundCommand.outputLines.push(line)
			}

			// Apply buffered streaming
			if (!didContinue) {
				outputBuffer.push(line)
				outputBufferSize += Buffer.byteLength(line, "utf8")
				// Flush if buffer is large enough
				if (outputBuffer.length >= CHUNK_LINE_COUNT || outputBufferSize >= CHUNK_BYTE_SIZE) {
					await flushBuffer()
				} else {
					scheduleFlush()
				}
			}
			// After "Proceed While Running": output is logged to file, not streamed to UI
		})

		let completed = false
		let completionTimer: NodeJS.Timeout | null = null

		// Start timer to detect if waiting for completion takes too long
		completionTimer = setTimeout(() => {
			if (!completed) {
				telemetryService.captureTerminalHang(TerminalHangStage.WAITING_FOR_COMPLETION)
				completionTimer = null
			}
		}, COMPLETION_TIMEOUT_MS)

		process.once("completed", async () => {
			completed = true
			// Clear the completion timer
			if (completionTimer) {
				clearTimeout(completionTimer)
				completionTimer = null
			}
			// Flush any remaining buffered output
			if (!didContinue && outputBuffer.length > 0) {
				if (chunkTimer) {
					clearTimeout(chunkTimer)
					chunkTimer = null
				}
				await flushBuffer(true)
			}
		})

		process.once("no_shell_integration", async () => {
			await this.callbacks.say("shell_integration_warning")
		})

		// In background mode, handle timeout or "Proceed While Running"
		if (timeoutSeconds) {
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error("COMMAND_TIMEOUT"))
				}, timeoutSeconds * 1000)
			})

			try {
				// Race between: process completion, timeout, and user clicking "Proceed While Running"
				const raceResult = await Promise.race([process.then(() => "completed" as const), timeoutPromise, proceedPromise])

				// Handle user clicking "Proceed While Running"
				if (raceResult === "proceed") {
					didContinue = true
					return await this.handleProceedWhileRunning(
						process,
						command,
						outputLines,
						cleanupProceedCheck,
						chunkTimer,
						completionTimer,
					)
				}
			} catch (error: any) {
				if (error.message === "COMMAND_TIMEOUT") {
					// Handle timeout the same way as "Proceed While Running"
					didContinue = true
					return await this.handleProceedWhileRunning(
						process,
						command,
						outputLines,
						cleanupProceedCheck,
						chunkTimer,
						completionTimer,
					)
				}
				throw error
			}
		} else {
			// No timeout - race between completion and "Proceed While Running"
			const raceResult = await Promise.race([process.then(() => "completed" as const), proceedPromise])

			if (raceResult === "proceed") {
				didContinue = true
				return await this.handleProceedWhileRunning(
					process,
					command,
					outputLines,
					cleanupProceedCheck,
					chunkTimer,
					completionTimer,
				)
			}
		}

		// Cleanup the proceed check interval if still running
		if (cleanupProceedCheck) {
			cleanupProceedCheck()
		}

		// Clear timer if process completes normally
		if (completionTimer) {
			clearTimeout(completionTimer)
			completionTimer = null
		}

		// Wait for a short delay to ensure all messages are sent to the webview
		await setTimeoutPromise(50)

		const result = this.terminalManager.processOutput(outputLines)

		if (userFeedback) {
			await this.callbacks.say("user_feedback", userFeedback.text, userFeedback.images, userFeedback.files)

			let fileContentString = ""
			if (userFeedback.files && userFeedback.files.length > 0) {
				fileContentString = await processFilesIntoText(userFeedback.files)
			}

			return [
				true,
				formatResponse.toolResult(
					`Command is still running in the user's terminal.${
						result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
					}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
					userFeedback.images,
					fileContentString,
				),
			]
		}

		if (completed) {
			return [false, `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`]
		} else {
			return [
				false,
				`Command is still running in the user's terminal.${
					result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
				}\n\nYou will be updated on the terminal status and new output in the future.`,
			]
		}
	}

	/**
	 * Helper method to handle "Proceed While Running" action.
	 * Tracks the command in BackgroundCommandTracker and returns immediately.
	 */
	private async handleProceedWhileRunning(
		process: TerminalProcessResultPromise,
		command: string,
		outputLines: string[],
		cleanupProceedCheck: (() => void) | undefined,
		chunkTimer: NodeJS.Timeout | null,
		completionTimer: NodeJS.Timeout | null,
	): Promise<[boolean, string]> {
		let trackedCommand: { logFilePath: string } | undefined
		if (this.backgroundCommandTracker) {
			trackedCommand = this.backgroundCommandTracker.trackCommand(process, command)
		}

		process.continue()

		// Cleanup timers
		if (cleanupProceedCheck) {
			cleanupProceedCheck()
		}
		if (chunkTimer) {
			clearTimeout(chunkTimer)
		}
		if (completionTimer) {
			clearTimeout(completionTimer)
		}

		// Send a message to the UI with the log file path
		if (trackedCommand) {
			await this.callbacks.say("command_output", `\n📋 Output is being logged to: ${trackedCommand.logFilePath}`)
		}

		await setTimeoutPromise(50)
		const result = this.terminalManager.processOutput(outputLines)

		// Build response message
		const logMsg = trackedCommand ? `Log file: ${trackedCommand.logFilePath}\n` : ""
		const outputMsg = result.length > 0 ? `Output so far:\n${result}` : ""

		return [false, `Command is running in the background. You can proceed with other tasks.\n${logMsg}${outputMsg}`]
	}

	/**
	 * Cancel the currently running background command
	 * @returns true if a command was cancelled, false otherwise
	 */
	async cancelBackgroundCommand(): Promise<boolean> {
		if (!this.activeBackgroundCommand) {
			return false
		}

		const { process, command, outputLines } = this.activeBackgroundCommand
		this.activeBackgroundCommand = undefined
		this.callbacks.updateBackgroundCommandState(false)

		try {
			// Try to terminate the process if the method exists
			if (typeof process.terminate === "function") {
				try {
					await process.terminate()
					Logger.info(`Terminated background command: ${command}`)
				} catch (error) {
					Logger.error(`Error terminating background command: ${command}`, error)
				}
			}

			// Ensure any pending operations complete
			if (typeof process.continue === "function") {
				try {
					process.continue()
				} catch (error) {
					Logger.error(`Error continuing background command: ${command}`, error)
				}
			}

			// Mark the command message as completed in the UI
			const clineMessages = this.callbacks.getClineMessages()
			const lastCommandIndex = this.findLastIndex(clineMessages, (m) => m.ask === "command" || m.say === "command")
			if (lastCommandIndex !== -1) {
				await this.callbacks.updateClineMessage(lastCommandIndex, {
					commandCompleted: true,
				})
			}

			// Process the captured output to include in the cancellation message
			const processedOutput = this.terminalManager.processOutput(outputLines, undefined, false)

			// Add cancellation information to the API conversation history
			let cancellationMessage = `Command "${command}" was cancelled by the user.`
			if (processedOutput.length > 0) {
				cancellationMessage += `\n\nOutput captured before cancellation:\n${processedOutput}`
			}

			this.callbacks.addToUserMessageContent({
				type: "text",
				text: cancellationMessage,
			})

			return true
		} catch (error) {
			Logger.error("Error in cancelBackgroundCommand", error)
			return false
		} finally {
			try {
				await this.callbacks.say("command_output", "Command execution has been cancelled.")
			} catch (error) {
				Logger.error("Failed to send cancellation notification", error)
			}
		}
	}

	/**
	 * Check if there's an active background command
	 */
	hasActiveBackgroundCommand(): boolean {
		return !!this.activeBackgroundCommand
	}

	/**
	 * Get the active background command info (for external access)
	 */
	getActiveBackgroundCommand(): ActiveBackgroundCommand | undefined {
		return this.activeBackgroundCommand
	}

	/**
	 * Helper to find last index matching a predicate
	 */
	private findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
		for (let i = array.length - 1; i >= 0; i--) {
			if (predicate(array[i])) {
				return i
			}
		}
		return -1
	}
}
