import { COMMAND_OUTPUT_STRING } from "../shared/const"
import { CodeyMessage } from "./interfaces"

/**
 * Combines API request start and finish messages in an array of CodeyMessages.
 *
 * This function looks for pairs of 'api_req_started' and 'api_req_finished' messages.
 * When it finds a pair, it combines them into a single 'api_req_combined' message.
 * The JSON data in the text fields of both messages are merged.
 *
 * @param messages - An array of CodeyMessage objects to process.
 * @returns A new array of CodeyMessage objects with API requests combined.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data"}', ts: 1000 },
 *   { type: "say", say: "api_req_finished", text: '{"cost":0.005}', ts: 1001 }
 * ];
 * const result = combineApiRequests(messages);
 * // Result: [{ type: "say", say: "api_req_started", text: '{"request":"GET /api/data","cost":0.005}', ts: 1000 }]
 */
export function combineApiRequests(messages: CodeyMessage[]): CodeyMessage[] {
	const combinedApiRequests: CodeyMessage[] = []

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].type === "say" && messages[i].say === "api_req_started") {
			let startedRequest = JSON.parse(messages[i].text || "{}")
			let j = i + 1

			while (j < messages.length) {
				if (messages[j].type === "say" && messages[j].say === "api_req_finished") {
					let finishedRequest = JSON.parse(messages[j].text || "{}")
					let combinedRequest = { ...startedRequest, ...finishedRequest }

					combinedApiRequests.push({
						...messages[i],
						text: JSON.stringify(combinedRequest),
					})

					i = j // Skip to the api_req_finished message
					break
				}
				j++
			}

			if (j === messages.length) {
				// If no matching api_req_finished found, keep the original api_req_started
				combinedApiRequests.push(messages[i])
			}
		}
	}

	// Replace original api_req_started and remove api_req_finished
	return messages
		.filter((msg) => !(msg.type === "say" && msg.say === "api_req_finished"))
		.map((msg) => {
			if (msg.type === "say" && msg.say === "api_req_started") {
				const combinedRequest = combinedApiRequests.find((req) => req.ts === msg.ts)
				return combinedRequest || msg
			}
			return msg
		})
}



/**
 * Combines sequences of command and command_output messages in an array of CodeyMessages.
 *
 * This function processes an array of CodeyMessages objects, looking for sequences
 * where a 'command' message is followed by one or more 'command_output' messages.
 * When such a sequence is found, it combines them into a single message, merging
 * their text contents.
 *
 * @param messages - An array of CodeyMessage objects to process.
 * @returns A new array of CodeyMessage objects with command sequences combined.
 *
 * @example
 * const messages: CodeyMessage[] = [
 *   { type: 'ask', ask: 'command', text: 'ls', ts: 1625097600000 },
 *   { type: 'ask', ask: 'command_output', text: 'file1.txt', ts: 1625097601000 },
 *   { type: 'ask', ask: 'command_output', text: 'file2.txt', ts: 1625097602000 }
 * ];
 * const result = simpleCombineCommandSequences(messages);
 * // Result: [{ type: 'ask', ask: 'command', text: 'ls\nfile1.txt\nfile2.txt', ts: 1625097600000 }]
 */
export function combineCommandSequences(messages: CodeyMessage[]): CodeyMessage[] {
	const combinedCommands: CodeyMessage[] = []

	// First pass: combine commands with their outputs
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].type === "ask" && messages[i].ask === "command") {
			let combinedText = messages[i].text || ""
			let didAddOutput = false
			let j = i + 1

			while (j < messages.length) {
				if (messages[j].type === "ask" && messages[j].ask === "command") {
					// Stop if we encounter the next command
					break
				}
				if (messages[j].ask === "command_output" || messages[j].say === "command_output") {
					if (!didAddOutput) {
						// Add a newline before the first output
						combinedText += `\n${COMMAND_OUTPUT_STRING}`
						didAddOutput = true
					}
					// handle cases where we receive empty command_output (ie when extension is relinquishing control over exit command button)
					const output = messages[j].text || ""
					if (output.length > 0) {
						combinedText += "\n" + output
					}
				}
				j++
			}

			combinedCommands.push({
				...messages[i],
				text: combinedText,
			})

			i = j - 1 // Move to the index just before the next command or end of array
		}
	}

	// Second pass: remove command_outputs and replace original commands with combined ones
	return messages
		.filter((msg) => !(msg.ask === "command_output" || msg.say === "command_output"))
		.map((msg) => {
			if (msg.type === "ask" && msg.ask === "command") {
				const combinedCommand = combinedCommands.find((cmd) => cmd.ts === msg.ts)
				return combinedCommand || msg
			}
			return msg
		})
}
