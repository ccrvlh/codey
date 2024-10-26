import { Anthropic } from "@anthropic-ai/sdk"
import * as diff from "diff"
import * as path from "path"
import { toolUseInstructionsReminder } from "./prompts"

export const formatResponse = {
  toolDenied: () => `The user denied this operation.`,

  toolDeniedWithFeedback: (feedback?: string) =>
    `The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>`,

  toolError: (error?: string) => `The tool execution failed with the following error:\n<error>\n${error}\n</error>`,

  noToolsUsed: () =>
    `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.

${toolUseInstructionsReminder}

# Next Steps

If you have completed the user's task, use the attempt_completion tool. 
If you require additional information from the user, use the ask_followup_question tool. 
Otherwise, if you have not completed the task and do not need additional information, then proceed with the next step of the task. 
(This is an automated message, so do not respond to it conversationally.)`,

  tooManyMistakes: (feedback?: string) =>
    `You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n${feedback}\n</feedback>`,

  missingToolParameterError: (paramName: string) =>
    `Missing value for required parameter '${paramName}'. Please retry with complete response.\n\n${toolUseInstructionsReminder}`,

  toolResult: (
    text: string,
    images?: string[]
  ): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
    if (images && images.length > 0) {
      const textBlock: Anthropic.TextBlockParam = { type: "text", text }
      const imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(images)
      // Placing images after text leads to better results
      return [textBlock, ...imageBlocks]
    } else {
      return text
    }
  },

  imageBlocks: (images?: string[]): Anthropic.ImageBlockParam[] => {
    return formatImagesIntoBlocks(images)
  },

  formatFilesList: (absolutePath: string, files: string[], didHitLimit: boolean): string => {
    const sorted = files
      .map((file) => {
        // convert absolute path to relative path
        const relativePath = path.relative(absolutePath, file).toPosix()
        return file.endsWith("/") ? relativePath + "/" : relativePath
      })
      // Sort so files are listed under their respective directories to make it clear what files are children of what directories. Since we build file list top down, even if file list is truncated it will show directories that cline can then explore further.
      .sort((a, b) => {
        const aParts = a.split("/") // only works if we use toPosix first
        const bParts = b.split("/")
        for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
          if (aParts[i] !== bParts[i]) {
            // If one is a directory and the other isn't at this level, sort the directory first
            if (i + 1 === aParts.length && i + 1 < bParts.length) {
              return -1
            }
            if (i + 1 === bParts.length && i + 1 < aParts.length) {
              return 1
            }
            // Otherwise, sort alphabetically
            return aParts[i].localeCompare(bParts[i], undefined, { numeric: true, sensitivity: "base" })
          }
        }
        // If all parts are the same up to the length of the shorter path,
        // the shorter one comes first
        return aParts.length - bParts.length
      })
    if (didHitLimit) {
      return `${sorted.join(
        "\n"
      )}\n\n(File list truncated. Use list_files on specific subdirectories if you need to explore further.)`
    } else if (sorted.length === 0 || (sorted.length === 1 && sorted[0] === "")) {
      return "No files found."
    } else {
      return sorted.join("\n")
    }
  },

  createPrettyPatch: (filename = "file", oldStr?: string, newStr?: string) => {
    // strings cannot be undefined or diff throws exception
    const patch = diff.createPatch(filename.toPosix(), oldStr || "", newStr || "")
    const lines = patch.split("\n")
    const prettyPatchLines = lines.slice(4)
    return prettyPatchLines.join("\n")
  },
}


// to avoid circular dependency
const formatImagesIntoBlocks = (images?: string[]): Anthropic.ImageBlockParam[] => {
  return images
    ? images.map((dataUrl) => {
      // data:image/png;base64,base64string
      const [rest, base64] = dataUrl.split(",")
      const mimeType = rest.split(":")[1].split(";")[0]
      return {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      } as Anthropic.ImageBlockParam
    })
    : []
}



/*
We can't implement a dynamically updating sliding window as it would break prompt cache
every time. To maintain the benefits of caching, we need to keep conversation history
static. This operation should be performed as infrequently as possible. If a user reaches
a 200k context, we can assume that the first half is likely irrelevant to their current task.
Therefore, this function should only be called when absolutely necessary to fit within
context limits, not as a continuous process.
*/
export function truncateHalfConversation(
  messages: Anthropic.Messages.MessageParam[]
): Anthropic.Messages.MessageParam[] {
  // API expects messages to be in user-assistant order, and tool use messages must be followed by tool results. We need to maintain this structure while truncating.

  // Always keep the first Task message (this includes the project's file structure in environment_details)
  const truncatedMessages = [messages[0]]

  // Remove half of user-assistant pairs
  const messagesToRemove = Math.floor(messages.length / 4) * 2 // has to be even number

  const remainingMessages = messages.slice(messagesToRemove + 1) // has to start with assistant message since tool result cannot follow assistant message with no tool use
  truncatedMessages.push(...remainingMessages)

  return truncatedMessages
}
