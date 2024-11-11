import { Anthropic } from "@anthropic-ai/sdk"
import os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { HistoryItem } from "../../shared/interfaces"


function generateFileName(history: HistoryItem, debug: boolean = false) {
	const date = new Date(history.ts)
	const month = (date.getMonth() + 1).toString().padStart(2, "0")
	const day = date.getDate()
	const year = date.getFullYear()
	let hours = date.getHours()
	const minutes = date.getMinutes().toString().padStart(2, "0")
	const seconds = date.getSeconds().toString().padStart(2, "0")
	const hoursStr = hours.toString().padStart(2, "0")
	return `${year}${month}${day}${hoursStr}${minutes}${seconds} Codey Task ${debug ? 'Debug' : ''} #${history.id}.json`
}

/**
 * Downloads a markdown file containing the conversation history of a task.
 *
 * @param history The task history item.
 * @param conversationHistory The conversation history of the task.
 */
export async function downloadTask(history: HistoryItem, conversationHistory: Anthropic.MessageParam[]) {
	const fileName = generateFileName(history, false)
	const markdownContent = conversationHistory
		.map((message) => {
			const role = message.role === "user" ? "**User:**" : "**Assistant:**"
			const content = Array.isArray(message.content)
				? message.content.map((block) => formatContentBlockToMarkdown(block)).join("\n")
				: message.content
			return `${role}\n\n${content}\n\n`
		})
		.join("---\n\n")


	const saveUri = await vscode.window.showSaveDialog({
		filters: { Markdown: ["md"] },
		defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", fileName)),
	})

	if (saveUri) {
		// Write content to the selected location
		await vscode.workspace.fs.writeFile(saveUri, new Uint8Array(Buffer.from(markdownContent)))
		vscode.window.showTextDocument(saveUri, { preview: true })
	}
}

/**
 * Downloads a JSON file containing the conversation history of a task for debugging purposes.
 *
 * @param history The task history item.
 * @param conversationHistory The conversation history of the task.
 */
export async function downloadTaskDebug(history: HistoryItem, conversationHistory: Anthropic.MessageParam[]) {
	const fileName = generateFileName(history, true)
	const jsonContent = JSON.stringify(conversationHistory, null, 2)
	const saveUri = await vscode.window.showSaveDialog({
		filters: { JSON: ["json"] },
		defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", fileName)),
	})
	if (saveUri) {
		await vscode.workspace.fs.writeFile(saveUri, new Uint8Array(Buffer.from(jsonContent)))
		vscode.window.showTextDocument(saveUri, { preview: true })
	}
}


/**
 * Converts a content block to a markdown string.
 *
 * @param block The content block to convert.
 */
export function formatContentBlockToMarkdown(
	block:
		| Anthropic.TextBlockParam
		| Anthropic.ImageBlockParam
		| Anthropic.ToolUseBlockParam
		| Anthropic.ToolResultBlockParam
	// messages: Anthropic.MessageParam[]
): string {
	switch (block.type) {
		case "text":
			return block.text
		case "image":
			return `[Image]`
		case "tool_use":
			let input: string
			if (typeof block.input === "object" && block.input !== null) {
				input = Object.entries(block.input)
					.map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`)
					.join("\n")
			} else {
				input = String(block.input)
			}
			return `[Tool Use: ${block.name}]\n${input}`
		case "tool_result":
			// For now we're not doing tool name lookup since we don't use tools anymore
			// const toolName = findToolName(block.tool_use_id, messages)
			const toolName = "Tool"
			if (typeof block.content === "string") {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]\n${block.content}`
			} else if (Array.isArray(block.content)) {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]\n${block.content
					.map((contentBlock) => formatContentBlockToMarkdown(contentBlock))
					.join("\n")}`
			} else {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]`
			}
		default:
			return "[Unexpected content type]"
	}
}

/**
 * Finds the name of a tool given its ID.
 *
 * @param toolCallId The ID of the tool.
 * @param messages The conversation messages.
 */
export function findToolName(toolCallId: string, messages: Anthropic.MessageParam[]): string {
	for (const message of messages) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "tool_use" && block.id === toolCallId) {
					return block.name
				}
			}
		}
	}
	return "Unknown Tool"
}
