import Anthropic from "@anthropic-ai/sdk"
import delay from "delay"
import fs from "fs/promises"
import path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { showOmissionWarning } from "../integrations/editor/detect-omission"
import { DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import { extractTextFromFile } from "../integrations/misc/extract-text"
import { listFiles } from "../services/glob/list-files"
import { regexSearchFiles } from "../services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter"
import { CodeySayTool } from "../shared/interfaces"
import { CodeyAsk } from "../shared/types"
import { ToolParamName, ToolResponse, ToolUse, ToolUseName } from "../types"
import { fileExistsAtPath } from "../utils/fs"
import { getReadablePath } from "../utils/path"
import { AgentConfig } from "./config"
import { responseTemplates } from "./formatter"
import { Agent } from "./main"

export class ToolExecutor {
  private diffViewProvider: DiffViewProvider
  private cwd: string
  private codey: Agent
  private config: AgentConfig
  private isExecutingTool: boolean = false

  constructor(agent: Agent, config: AgentConfig, cwd: string, diffViewProvider: DiffViewProvider) {
    this.codey = agent
    this.config = config
    this.cwd = cwd
    this.diffViewProvider = diffViewProvider
    this.isExecutingTool = false
  }

  // Privates

  /**
   * Cleans up the provided content string by removing unwanted artifacts and escape characters.
   * Useful for cases where weaker models might add artifacts like markdown codeblock markers
   *
   * - Removes leading and trailing markdown code block markers (```).
   * - Handles cases where it includes language specifiers like ```python ```js
   * - Replaces HTML escape characters (&gt;, &lt;, &quot;) with their corresponding symbols.
   *
   * @param content - The content string to be cleaned up.
   * @returns The cleaned-up content string.
   */
  private cleanUpContent(content: string): string {
    if (content.startsWith("```")) {
      content = content.split("\n").slice(1).join("\n").trim()
    }
    if (content.endsWith("```")) {
      content = content.split("\n").slice(0, -1).join("\n").trim()
    }

    if (content.includes("&gt;") || content.includes("&lt;") || content.includes("&quot;")) {
      content = content
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
    }
    return content
  }

  /**
   * Removes the closing tag from the provided text if the block is partial.
   * If block is partial, remove partial closing tag so its not presented to user
   * as a closing tag.
   *
   * Uses a regex pattern to match the closing tag dynamically based on the tag name.
   * Matches optional whitespace before the tag, and matches '<' or '</' optionally followed by any subset of characters from the tag name.
   *
   * @param block - The tool use block which indicates if it is partial.
   * @param tag - The tag name to be removed from the text.
   * @param text - The text from which the closing tag should be removed.
   * @returns The text with the closing tag removed if the block is partial, otherwise returns the original text.
   */
  private removeClosingTag(block: ToolUse, tag: ToolParamName, text?: string) {
    if (!block.partial) {
      return text || ""
    }
    if (!text) {
      return ""
    }
    const tagRegex = new RegExp(
      `\\s?<\/?${tag
        .split("")
        .map((char) => `(?:${char})?`)
        .join("")}$`,
      "g"
    )
    return text.replace(tagRegex, "")
  }

  async askApproval(block: ToolUse, type: CodeyAsk, partialMessage?: string) {
    const { response, text, images } = await this.codey.askUser(type, partialMessage, false)
    if (response === "yesButtonClicked") {
      return true
    }
    if (response === "messageResponse") {
      await this.codey.sendMessage("user_feedback", text, images)
      this.codey.pushToolResult(
        block,
        responseTemplates.toolResult(responseTemplates.toolDeniedWithFeedback(text), images)
      )
      this.codey.didRejectTool = true
      return false
    }
    this.codey.pushToolResult(block, responseTemplates.toolDenied())
    this.codey.didRejectTool = true
    return false
  }

  async handleError(block: ToolUse, action: string, error: Error) {
    const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
    await this.codey.sendMessage(
      "error",
      `Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
    )
    this.codey.pushToolResult(block, responseTemplates.toolError(errorString))
  }

  async handleMissingParamError(toolName: ToolUseName, paramName: string, relPath?: string): Promise<string> {
    const pathInfo = `${relPath ? ` for '${relPath.toPosix()}'` : ""}`
    const detailedError = `Codey tried to use ${toolName}${pathInfo} without value for required parameter '${paramName}'. Retrying...`
    await this.codey.sendMessage("error", detailedError)
    const error = responseTemplates.missingToolParameterError(paramName)
    return responseTemplates.toolError(error)
  }

  // Tools

  async writeToFileTool(block: ToolUse) {
    const relPath: string | undefined = block.params.path
    let newContent: string | undefined = block.params.content
    if (!relPath || !newContent) {
      // checking for newContent ensure relPath is complete
      // wait so we can determine if it's a new file or editing an existing file
      return
    }
    // Check if file exists using cached map or fs.access
    let fileExists: boolean
    if (this.diffViewProvider.editType !== undefined) {
      fileExists = this.diffViewProvider.editType === "modify"
    } else {
      const absolutePath = path.resolve(this.cwd, relPath)
      fileExists = await fileExistsAtPath(absolutePath)
      this.diffViewProvider.editType = fileExists ? "modify" : "create"
    }

    newContent = this.cleanUpContent(newContent)
    const sharedMessageProps: CodeySayTool = {
      tool: fileExists ? "editedExistingFile" : "newFileCreated",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relPath)),
    }

    try {
      if (block.partial) {
        // update gui message
        const partialMessage = JSON.stringify(sharedMessageProps)
        await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {})
        // update editor
        if (!this.diffViewProvider.isEditing) {
          // open the editor and prepare to stream content in
          await this.diffViewProvider.open(relPath)
        }
        // editor is open, stream content in
        await this.diffViewProvider.update(newContent, false, this.config.editAutoScroll)
        return
      }
      if (!relPath) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("write_to_file", "path"))
        await this.diffViewProvider.reset()
        return
      }
      if (!newContent) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("write_to_file", "content"))
        await this.diffViewProvider.reset()
        return
      }
      this.codey.consecutiveMistakeCount = 0

      // if isEditingFile false, that means we have the full contents of the file already.
      // it's important to note how this function works,
      // you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data.
      // So this part of the logic will always be called.
      // in other words, you must always repeat the block.partial logic here
      if (!this.diffViewProvider.isEditing) {
        // show gui message before showing edit animation
        const partialMessage = JSON.stringify(sharedMessageProps)

        // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
        await this.codey.askUser("tool", partialMessage, true).catch(() => {})
        await this.diffViewProvider.open(relPath)
      }
      await this.diffViewProvider.update(newContent, true, this.config.editAutoScroll)
      await delay(300) // wait for diff view to update
      this.diffViewProvider.scrollToFirstDiff()
      showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: fileExists ? undefined : newContent,
        diff: fileExists
          ? responseTemplates.createPrettyPatch(relPath, this.diffViewProvider.originalContent, newContent)
          : undefined,
      } satisfies CodeySayTool)
      const didApprove = await this.askApproval(block, "tool", completeMessage)
      if (!didApprove) {
        await this.diffViewProvider.revertChanges()
        return
      }
      const { newProblemsMessage, userEdits, finalContent } = await this.diffViewProvider.saveChanges()
      this.codey.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
      if (!userEdits) {
        this.codey.pushToolResult(
          block,
          `The content was successfully saved to ${relPath.toPosix()}.${newProblemsMessage}`
        )
        await this.diffViewProvider.reset()
        return
      }

      const userFeedbackDiff = JSON.stringify({
        tool: fileExists ? "editedExistingFile" : "newFileCreated",
        path: getReadablePath(this.cwd, relPath),
        diff: userEdits,
      } satisfies CodeySayTool)
      await this.codey.sendMessage("user_feedback_diff", userFeedbackDiff)
      this.codey.pushToolResult(
        block,
        `The user made the following updates to your content:\n\n${userEdits}\n\n` +
          `The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file:\n\n` +
          `<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
          `Please note:\n` +
          `1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
          `2. Proceed with the task using this updated file content as the new baseline.\n` +
          `3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
          `${newProblemsMessage}`
      )
      await this.diffViewProvider.reset()
      return
    } catch (error) {
      await this.handleError(block, "writing file", error)
      await this.diffViewProvider.reset()
      return
    }
  }

  async readFileTool(block: ToolUse) {
    const relPath: string | undefined = block.params.path
    const cleanPath = this.removeClosingTag(block, "path", relPath)
    const sharedMessageProps: CodeySayTool = {
      tool: "readFile",
      path: getReadablePath(this.cwd, cleanPath),
    }
    try {
      if (block.partial) {
        console.debug("Partial block on read file tool")
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: undefined,
        } satisfies CodeySayTool)
        if (this.config.alwaysAllowReadOnly) {
          await this.codey.sendMessage("tool", partialMessage, undefined, block.partial)
        } else {
          await this.codey.askUser("tool", partialMessage, block.partial).catch((e) => {
            console.error("[ERROR] Partial message ask failed: ", e.message)
          })
        }
        return
      }

      if (!relPath) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("read_file", "path"))
        return
      }

      this.codey.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relPath)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: absolutePath,
      } satisfies CodeySayTool)

      if (this.config.alwaysAllowReadOnly) {
        // need to be sending partialValue bool
        // since undefined has its own purpose in that the message is treated neither as a partial or completion of a partial
        // but as a single complete message
        console.debug("[DEBUG] Sending read file tool message")
        await this.codey.sendMessage("tool", completeMessage, undefined, false)
      } else {
        console.debug("[DEBUG] Asking for user's permission to read the file")
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          console.warn("[WARN] User did not approve file read. Skipping.")
          return
        }
      }

      const content = await extractTextFromFile(absolutePath)
      const lineCount = content.split("\n").length
      const hasLinesParams = block.params.lines !== undefined

      if (!hasLinesParams && lineCount > this.config.maxFileLineThreshold) {
        console.warn(`[WARN] File ${absolutePath} LOC above threshold (${lineCount}), showing definitions...`)
        const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath).catch((e) => {
          console.error(`[ERROR] Failed to parse definitions for ${absolutePath}: ${e.message}`)
          return "Failed to parse definitions for this file."
        })
        this.codey.pushToolResult(
          block,
          `File is too large (${lineCount} lines). Showing code definitions instead.
          If you need to read specific parts of the file, ask again with the "lines" range param.
          Definitions:\n\n${result}`
        )
        return
      }

      if (!hasLinesParams) {
        this.codey.pushToolResult(block, content)
        return
      }

      const lineRange = block.params.lines?.split(":")
      const startLine = parseInt(lineRange?.[0] ?? "1", 10)
      const endLine = parseInt(lineRange?.[1] ?? "1", 10)
      const specificContent = content
        .split("\n")
        .slice(startLine - 1, endLine)
        .join("\n")
      this.codey.pushToolResult(block, specificContent)
    } catch (error) {
      await this.handleError(block, "reading file", error)
      return
    }
  }

  async listFilesTool(block: ToolUse) {
    const relDirPath: string | undefined = block.params.path
    const recursiveRaw: string | undefined = block.params.recursive
    const recursive = recursiveRaw?.toLowerCase() === "true"
    const sharedMessageProps: CodeySayTool = {
      tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relDirPath)),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: "",
        } satisfies CodeySayTool)
        if (this.config.alwaysAllowReadOnly) {
          await this.codey.sendMessage("tool", partialMessage, undefined, block.partial)
        } else {
          await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {})
        }
        return
      }
      if (!relDirPath) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("list_files", "path"))
        return
      }
      this.codey.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
      const result = responseTemplates.formatFilesList(absolutePath, files, didHitLimit)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies CodeySayTool)
      if (this.config.alwaysAllowReadOnly) {
        await this.codey.sendMessage("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.codey.pushToolResult(block, result)
      return
    } catch (error) {
      await this.handleError(block, "listing files", error)
      return
    }
  }

  async listCodeDefinitionNamesTool(block: ToolUse) {
    const relDirPath: string | undefined = block.params.path
    const sharedMessageProps: CodeySayTool = {
      tool: "listCodeDefinitionNames",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relDirPath)),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: "",
        } satisfies CodeySayTool)
        if (this.config.alwaysAllowReadOnly) {
          await this.codey.sendMessage("tool", partialMessage, undefined, block.partial)
        } else {
          await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {})
        }
        return
      }
      if (!relDirPath) {
        this.codey.consecutiveMistakeCount++
        const errorResult = await this.handleMissingParamError("list_code_definition_names", "path")
        this.codey.pushToolResult(block, errorResult)
        return
      }
      this.codey.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies CodeySayTool)
      if (this.config.alwaysAllowReadOnly) {
        await this.codey.sendMessage("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.codey.pushToolResult(block, result)
      return
    } catch (error) {
      await this.handleError(block, "parsing source code definitions", error)
      return
    }
  }

  async searchFilesTool(block: ToolUse) {
    const relDirPath: string | undefined = block.params.path
    const regex: string | undefined = block.params.regex
    const filePattern: string | undefined = block.params.file_pattern
    const sharedMessageProps: CodeySayTool = {
      tool: "searchFiles",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relDirPath)),
      regex: this.removeClosingTag(block, "regex", regex),
      filePattern: this.removeClosingTag(block, "file_pattern", filePattern),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: "",
        } satisfies CodeySayTool)
        if (this.config.alwaysAllowReadOnly) {
          await this.codey.sendMessage("tool", partialMessage, undefined, block.partial)
        } else {
          await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {})
        }
        return
      }
      if (!relDirPath) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("search_files", "path"))
        return
      }
      if (!regex) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("search_files", "regex"))
        return
      }

      this.codey.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const results = await regexSearchFiles(this.cwd, absolutePath, regex, filePattern)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: results,
      } satisfies CodeySayTool)

      if (this.config.alwaysAllowReadOnly) {
        await this.codey.sendMessage("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.codey.pushToolResult(block, results)
      return
    } catch (error) {
      await this.handleError(block, "searching files", error)
      return
    }
  }

  async inspectSizeTool(block: ToolUse) {
    const url: string | undefined = block.params.url
    const sharedMessageProps: CodeySayTool = {
      tool: "inspectSite",
      path: this.removeClosingTag(block, "url", url),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify(sharedMessageProps)
        if (this.config.alwaysAllowReadOnly) {
          await this.codey.sendMessage("tool", partialMessage, undefined, block.partial)
        } else {
          await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {})
        }
        return
      }
      if (!url) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("inspect_site", "url"))
        return
      }
      this.codey.consecutiveMistakeCount = 0
      const completeMessage = JSON.stringify(sharedMessageProps)
      if (this.config.alwaysAllowReadOnly) {
        await this.codey.sendMessage("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }

      // execute tool
      // NOTE: it's okay that we call this message since the partial inspect_site is finished streaming.
      // The only scenario we have to avoid is sending messages WHILE a partial message exists at the end of the messages array.
      // For example the api_req_finished message would interfere with the partial message, so we needed to remove that.
      // no result, starts the loading spinner waiting for result
      await this.codey.sendMessage("inspect_site_result", "")
      await this.codey.urlContentFetcher.launchBrowser()
      let result: {
        screenshot: string
        logs: string
      }
      try {
        result = await this.codey.urlContentFetcher.urlToScreenshotAndLogs(url)
      } finally {
        await this.codey.urlContentFetcher.closeBrowser()
      }
      const { screenshot, logs } = result
      await this.codey.sendMessage("inspect_site_result", logs, [screenshot])

      this.codey.pushToolResult(
        block,
        responseTemplates.toolResult(
          `The site has been visited, with console logs captured and a screenshot taken for your analysis.\n\nConsole logs:\n${
            logs || "(No logs)"
          }`,
          [screenshot]
        )
      )
      return
    } catch (error) {
      await this.handleError(block, "inspecting site", error)
      return
    }
  }

  async executeCommandTool(block: ToolUse) {
    const command: string | undefined = block.params.command
    try {
      if (block.partial) {
        await this.codey
          .askUser("command", this.removeClosingTag(block, "command", command), block.partial)
          .catch(() => {})
        return
      } else {
        if (!command) {
          this.codey.consecutiveMistakeCount++
          this.codey.pushToolResult(block, await this.handleMissingParamError("execute_command", "command"))
          return
        }
        this.codey.consecutiveMistakeCount = 0
        const didApprove = await this.askApproval(block, "command", command)
        if (!didApprove) {
          return
        }
        const [userRejected, result] = await this.codey.executeCommand(command)
        if (userRejected) {
          this.codey.didRejectTool = true
        }
        this.codey.pushToolResult(block, result)
        return
      }
    } catch (error) {
      await this.handleError(block, "inspecting site", error)
      return
    }
  }

  async attemptCompletionTool(block: ToolUse) {
    const result: string | undefined = block.params.result
    const command: string | undefined = block.params.command
    try {
      const lastMessage = this.codey.codeyMessages.at(-1)
      if (block.partial) {
        if (command) {
          // the attempt_completion text is done, now we're getting command
          // remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

          // const secondLastMessage = this.codeyMessages.at(-2)
          if (lastMessage && lastMessage.ask === "command") {
            // update command
            await this.codey
              .askUser("command", this.removeClosingTag(block, "command", command), block.partial)
              .catch(() => {})
          } else {
            // last message is completion_result
            // we have command string, which means we have the result as well, so finish it (doesnt have to exist yet)
            await this.codey.sendMessage(
              "completion_result",
              this.removeClosingTag(block, "result", result),
              undefined,
              false
            )
            await this.codey
              .askUser("command", this.removeClosingTag(block, "command", command), block.partial)
              .catch(() => {})
          }
        } else {
          // no command, still outputting partial result
          await this.codey.sendMessage(
            "completion_result",
            this.removeClosingTag(block, "result", result),
            undefined,
            block.partial
          )
        }
        return
      }
      if (!result) {
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("attempt_completion", "result"))
        return
      }
      this.codey.consecutiveMistakeCount = 0

      let commandResult: ToolResponse | undefined
      if (command) {
        if (lastMessage && lastMessage.ask !== "command") {
          // havent sent a command message yet so first send completion_result then command
          await this.codey.sendMessage("completion_result", result, undefined, false)
        }

        // complete command message
        const didApprove = await this.askApproval(block, "command", command)
        if (!didApprove) {
          return
        }
        const [userRejected, execCommandResult] = await this.codey.executeCommand(command!)
        if (userRejected) {
          this.codey.didRejectTool = true
          this.codey.pushToolResult(block, execCommandResult)
          return
        }
        // user didn't reject, but the command may have output
        commandResult = execCommandResult
      } else {
        await this.codey.sendMessage("completion_result", result, undefined, false)
      }

      // we already sent completion_result says, an empty string asks relinquishes control over button and field
      const { response, text, images } = await this.codey.askUser("completion_result", "", false)
      if (response === "yesButtonClicked") {
        this.codey.pushToolResult(block, "") // signals to recursive loop to stop (for now this never happens since yesButtonClicked will trigger a new task)
        return
      }
      await this.codey.sendMessage("user_feedback", text ?? "", images)

      const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
      if (commandResult) {
        if (typeof commandResult === "string") {
          toolResults.push({ type: "text", text: commandResult })
        } else if (Array.isArray(commandResult)) {
          toolResults.push(...commandResult)
        }
      }
      toolResults.push({
        type: "text",
        text: `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
      })
      toolResults.push(...responseTemplates.imageBlocks(images))
      this.codey.userMessageContent.push({
        type: "text",
        text: `$getToolDescription(block)} Result:`,
      })
      this.codey.userMessageContent.push(...toolResults)

      return
    } catch (error) {
      await this.handleError(block, "inspecting site", error)
      return
    }
  }

  async askFollowupQuestionTool(block: ToolUse) {
    const question: string | undefined = block.params.question
    try {
      if (block.partial) {
        await this.codey
          .askUser("followup", this.removeClosingTag(block, "question", question), block.partial)
          .catch(() => {})
        return
      }
      if (!question) {
        this.codey.consecutiveMistakeCount++
        const missingParamError = await this.handleMissingParamError("ask_followup_question", "question")
        this.codey.pushToolResult(block, missingParamError)
        return
      }
      this.codey.consecutiveMistakeCount = 0
      const { text, images } = await this.codey.askUser("followup", question, false)
      await this.codey.sendMessage("user_feedback", text ?? "", images)
      const response = responseTemplates.toolResult(`<answer>\n${text}\n</answer>`, images)
      this.codey.pushToolResult(block, response)
      return
    } catch (error) {
      await this.handleError(block, "asking question", error)
      return
    }
  }

  async searchReplaceTool(block: ToolUse) {
    console.debug("[DEBUG] Search and replace tool running...")
    const contentParam: string | undefined = block.params.content
    const relPath: string | undefined = block.params.path
    const cleanPath = this.removeClosingTag(block, "path", relPath)
    const sharedMessageProps: CodeySayTool = {
      tool: "searchReplace",
      path: getReadablePath(this.cwd, cleanPath),
    }

    if (!contentParam) {
      console.warn("[WARN] Content parameter is missing. Waiting for the full content to come in.")
      return
    }

    try {
      const content = this.cleanUpContent(contentParam)
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: undefined,
        } satisfies CodeySayTool)
        await this.codey.askUser("tool", partialMessage, block.partial).catch((e) => {
          console.error("[ERROR] Partial message ask failed: ", e.message)
        })
        return
      }

      const lines = content.split("\n")
      const filePath = lines[0]?.trim()
      console.debug("[DEBUG] File path:", filePath)
      if (!filePath) {
        await this.handleError(block, "performing search and replace", new Error("file path not provided"))
        return
      }

      // Find the sections
      let searchContent = ""
      let replaceContent = ""
      let currentSection: "none" | "search" | "replace" = "none"

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        console.debug(`Processing line ${i}:`, line)

        if (line.match(/^<{5,9} SEARCH\s*$/)) {
          currentSection = "search"
          continue
        }
        if (line.match(/^={5,9}\s*$/)) {
          currentSection = "replace"
          continue
        }
        if (line.match(/^>{5,9} REPLACE\s*$/)) {
          break
        }

        // Add lines to appropriate section
        if (currentSection === "search") {
          searchContent += (searchContent ? "\n" : "") + line
        } else if (currentSection === "replace") {
          replaceContent += (replaceContent ? "\n" : "") + line
        }
      }

      // Validate we have all required parts
      if (!searchContent || !replaceContent) {
        console.debug(
          "[DEBUG] Missing required search/replace content parts... Waiting for the full content to come in."
        )
        return
      }

      const absolutePath = path.resolve(this.cwd, filePath)
      console.debug("[DEBUG] Absolute file path:", absolutePath)
      const originalContent = await fs.readFile(absolutePath, "utf8")
      console.debug("[DEBUG] Original file content:", originalContent)

      // Open the file in diff view
      const document = await vscode.workspace.openTextDocument(absolutePath)
      const editor = await vscode.window.showTextDocument(document)
      console.debug("[DEBUG] Opened file in editor.")
      const fileContent = document.getText()

      // Find the index of the content to search
      const searchIndex = fileContent.indexOf(searchContent)
      console.debug("[DEBUG] Search content index:", searchIndex)

      if (searchIndex === -1) {
        const err = new Error(
          "search content not found in file. make sure you're using the right search content, and the right file path."
        )
        await this.handleError(block, "couldn't find search content", err)
        await this.diffViewProvider.reset()
        return
      }

      // Create positions and range for the search content
      const startPos = document.positionAt(searchIndex)
      const endPos = document.positionAt(searchIndex + searchContent.length)
      const range = new vscode.Range(startPos, endPos)
      console.debug("[DEBUG] Range for replacement:", range)

      // Apply the replacement with the specified format
      await editor.edit((editBuilder) => {
        editBuilder.insert(range.start, `<<<<<<< SEARCH\n`)
        editBuilder.insert(range.end, `\n=======\n${replaceContent}\n>>>>>>> REPLACE`)
      })
      console.debug("[DEBUG] Applied replacement in editor.")

      // Move the cursor to the beginning of the `replaceContent`
      const dividerLength = 9 // Length of `=======\n`
      const replaceStartPos = document.positionAt(searchIndex + searchContent.length + dividerLength)
      editor.selection = new vscode.Selection(replaceStartPos, replaceStartPos)
      editor.revealRange(new vscode.Range(replaceStartPos, replaceStartPos), vscode.TextEditorRevealType.InCenter)
      console.debug("[DEBUG] Set cursor position to the start of the replaced content.")

      const completeMessage = JSON.stringify({
        tool: "searchReplace",
        path: filePath,
        diff: responseTemplates.createPrettyPatch(filePath, originalContent, document.getText()),
      } satisfies CodeySayTool)

      const didApprove = await this.askApproval(block, "tool", completeMessage)
      if (!didApprove) {
        await this.diffViewProvider.revertChanges()
        return
      }

      // After approval, clean up the merge conflict notation
      const fullContent = document.getText()
      const mergeStartIndex = fullContent.indexOf("<<<<<<< SEARCH\n")
      const mergeEndIndex = fullContent.indexOf(">>>>>>> REPLACE") + ">>>>>>> REPLACE".length

      if (mergeStartIndex !== -1 && mergeEndIndex !== -1) {
        const replaceStart = fullContent.indexOf("=======\n") + "=======\n".length
        const replaceEnd = fullContent.indexOf("\n>>>>>>> REPLACE")
        const cleanedReplacement = fullContent.substring(replaceStart, replaceEnd)

        await editor.edit((editBuilder) => {
          const entireRange = new vscode.Range(document.positionAt(mergeStartIndex), document.positionAt(mergeEndIndex))
          editBuilder.replace(entireRange, cleanedReplacement)
        })

        await document.save()
        const response = `Search and replace completed successfully in ${filePath}. The merge conflict notation has been cleaned up and the replacement content has been saved.`
        this.codey.pushToolResult(block, response)
        await this.diffViewProvider.reset()
        return
      }

      // Show changes and get approval
      const { newProblemsMessage, userEdits } = await this.diffViewProvider.saveChanges()
      console.debug("Saved changes. New problems message:", newProblemsMessage, "User edits:", userEdits)
      this.codey.didEditFile = true

      if (!userEdits) {
        this.codey.pushToolResult(
          block,
          `Search and replace completed successfully in ${filePath}.${newProblemsMessage}`
        )
        await this.diffViewProvider.reset()
        return
      }

      // Handle user edits if any
      const userFeedbackDiff = JSON.stringify({
        tool: "searchReplace",
        path: filePath,
        diff: userEdits,
      } satisfies CodeySayTool)

      await this.codey.sendMessage("user_feedback_diff", userFeedbackDiff)
      this.codey.pushToolResult(
        block,
        `The user made the following updates:\n\n${userEdits}\n\n` +
          `Changes applied successfully to ${filePath}.${newProblemsMessage}`
      )
      await this.diffViewProvider.reset()
    } catch (error) {
      console.error("[ERROR] Error during search and replace:", error)
      await this.handleError(block, "performing search and replace", error)
      await this.diffViewProvider.reset()
      return
    }
  }

  async insertCodeBlockTool(block: ToolUse) {
    console.debug("insertCodeBlockTool called with block:", block)
    const relPath: string | undefined = block.params.path
    const position: string | undefined = block.params.position
    const content: string | undefined = block.params.content

    const sharedMessageProps: CodeySayTool = {
      tool: "insertCodeBlock",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relPath)),
    }

    if (!content) {
      console.debug("Content is missing.")
      return
    }

    const newContent = this.cleanUpContent(content)
    console.debug("Cleaned up content:", newContent)

    try {
      if (block.partial) {
        console.debug("Block is partial, sending partial message.")
        const partialMessage = JSON.stringify(sharedMessageProps)
        await this.codey.askUser("tool", partialMessage, block.partial).catch(() => {
          console.debug("Partial message ask failed.")
        })
        return
      }

      // Validate required parameters
      if (!relPath) {
        console.debug("Path is missing.")
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("insert_code_block", "path"))
        return
      }
      if (!position) {
        console.debug("Position is missing.")
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("insert_code_block", "position"))
        return
      }
      if (!content) {
        console.debug("Content is missing.")
        this.codey.consecutiveMistakeCount++
        this.codey.pushToolResult(block, await this.handleMissingParamError("insert_code_block", "content"))
        return
      }

      this.codey.consecutiveMistakeCount = 0

      // Read the file
      const absolutePath = path.resolve(this.cwd, relPath)
      console.debug("Resolved absolute path:", absolutePath)
      const fileContent = await fs.readFile(absolutePath, "utf8")
      this.diffViewProvider.editType = "modify"
      this.diffViewProvider.originalContent = fileContent
      console.debug("Read file content:", fileContent)
      const lines = fileContent.split("\n")
      console.debug("File content split into lines:", lines)

      // Convert position to number and validate
      const lineNumber = parseInt(position)
      console.debug("Parsed line number:", lineNumber)
      if (isNaN(lineNumber) || lineNumber < 0 || lineNumber > lines.length) {
        throw new Error(`Invalid position: ${position}. Must be a number between 0 and ${lines.length}`)
      }

      // Insert the code block at the specified position
      const contentLines = content.split("\n")
      console.debug("Content split into lines:", contentLines)
      const targetLine = lineNumber - 1
      console.debug("Target line for insertion:", targetLine)

      lines.splice(targetLine, 0, ...contentLines)
      const updatedContent = lines.join("\n")
      console.debug("New content with insertion:", updatedContent)

      // Show changes in diff view
      if (!this.diffViewProvider.isEditing) {
        console.debug("Diff view is not editing, opening diff view.")
        await this.codey.askUser("tool", JSON.stringify(sharedMessageProps), true).catch(() => {
          console.debug("Diff view opening ask failed.")
        })
        // First open with original content
        await this.diffViewProvider.open(relPath)
        await this.diffViewProvider.update(fileContent, false, this.config.editAutoScroll, true)
        this.diffViewProvider.scrollEditorToLine(targetLine)
        await delay(200)
      }

      console.debug("Updating diff view with new content.")
      await this.diffViewProvider.update(updatedContent, true, this.config.editAutoScroll, true)

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        diff: responseTemplates.createPrettyPatch(relPath, this.diffViewProvider.originalContent, updatedContent),
      } satisfies CodeySayTool)

      console.debug("Asking for approval with complete message:", completeMessage)
      const didApprove = await this.codey
        .askUser("tool", completeMessage, false)
        .then((response) => response.response === "yesButtonClicked")

      if (!didApprove) {
        console.debug("Changes were not approved, reverting changes.")
        await this.diffViewProvider.revertChanges()
        this.codey.pushToolResult(block, "Changes were rejected by the user.")
        return
      }

      console.debug("Saving changes after approval.")
      const { newProblemsMessage, userEdits, finalContent } = await this.diffViewProvider.saveChanges()
      this.codey.didEditFile = true

      if (!userEdits) {
        console.debug("No user edits, pushing tool result.")
        this.codey.pushToolResult(
          block,
          `The code block was successfully inserted at line ${position} in ${relPath.toPosix()}.${newProblemsMessage}`
        )
        await this.diffViewProvider.reset()
        return
      }

      const userFeedbackDiff = JSON.stringify({
        tool: "insertCodeBlock",
        path: getReadablePath(this.cwd, relPath),
        diff: userEdits,
      } satisfies CodeySayTool)

      console.debug("User made edits, sending feedback diff:", userFeedbackDiff)
      await this.codey.sendMessage("user_feedback_diff", userFeedbackDiff)
      this.codey.pushToolResult(
        block,
        `The user made the following updates to your content:\n\n${userEdits}\n\n` +
          `The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file:\n\n` +
          `<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
          `Please note:\n` +
          `1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
          `2. Proceed with the task using this updated file content as the new baseline.\n` +
          `3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
          `${newProblemsMessage}`
      )
      await this.diffViewProvider.reset()
    } catch (error) {
      console.error("Error inserting code block:", error)
      const errorString = `Error inserting code block: ${JSON.stringify(error)}`
      await this.codey.sendMessage(
        "error",
        `Error inserting code block:\n${error.message ?? JSON.stringify(error, null, 2)}`
      )
      this.codey.pushToolResult(block, responseTemplates.toolError(errorString))
      await this.diffViewProvider.reset()
    }
  }

  // Handle Tool Execution

  async handleToolUse(block: ToolUse) {
    if (this.isExecutingTool) {
      return
    }
    this.isExecutingTool = true
    try {
      switch (block.name) {
        case "write_to_file": {
          console.debug("[DEBUG] Write to file tool called with block:", block)
          await this.writeToFileTool(block)
          return
        }
        case "read_file": {
          console.debug("[DEBUG] Read file tool called with block:", block)
          await this.readFileTool(block)
          return
        }
        case "list_files": {
          console.debug("[DEBUG] List files tool called with block:", block)
          await this.listFilesTool(block)
          return
        }
        case "list_code_definition_names": {
          console.debug("[DEBUG] List code definition names tool called with block:", block)
          await this.listCodeDefinitionNamesTool(block)
          return
        }
        case "search_files": {
          console.debug("[DEBUG] Search files tool called with block:", block)
          await this.searchFilesTool(block)
          return
        }
        case "inspect_site": {
          console.debug("[DEBUG] Inspect site tool called with block:", block)
          await this.inspectSizeTool(block)
          return
        }
        case "execute_command": {
          console.debug("[DEBUG] Execute command tool called with block:", block)
          await this.executeCommandTool(block)
          return
        }
        case "ask_followup_question": {
          console.debug("[DEBUG] Ask follow-up question tool called with block:", block)
          await this.askFollowupQuestionTool(block)
          return
        }
        case "attempt_completion": {
          console.debug("[DEBUG] Attempt completion tool called with block:", block)
          await this.attemptCompletionTool(block)
          return
        }
        case "search_replace": {
          console.debug("[DEBUG] Search and replace tool called with block:", block)
          await this.searchReplaceTool(block)
          return
        }
        case "insert_code_block": {
          console.debug("[DEBUG] Insert code block tool called with block:", block)
          await this.insertCodeBlockTool(block)
          return
        }
      }
    } catch (e) {
      console.error("[ERROR] Error handling tool use:", e)
    } finally {
      this.isExecutingTool = false
    }
  }
}
