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
import { ClineAsk, ClineSayTool } from "../shared/ExtensionMessage"
import { ToolParamName, ToolResponse, ToolUse } from "../types"
import { fileExistsAtPath } from "../utils/fs"
import { getReadablePath } from "../utils/path"
import { formatResponse } from "./formatter"
import { Cline } from "./main"

export class ToolExecutor {
  private static readonly MAX_FILE_LINES = 500;
  private diffViewProvider: DiffViewProvider
  private cwd: string
  private cline: Cline

  constructor(cline: Cline, cwd: string, diffViewProvider: DiffViewProvider) {
    this.cline = cline
    this.cwd = cwd
    this.diffViewProvider = diffViewProvider
  }

  // Privates

  private cleanUpContent(content: string): string {
    // pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers
    // (deepseek/llama) or extra escape characters (gemini)
    if (content.startsWith("```")) {
      // this handles cases where it includes language specifiers like ```python ```js
      content = content.split("\n").slice(1).join("\n").trim()
    }
    if (content.endsWith("```")) {
      content = content.split("\n").slice(0, -1).join("\n").trim()
    }

    // it seems not just llama models are doing this, but also gemini and potentially others
    if (
      content.includes("&gt;") ||
      content.includes("&lt;") ||
      content.includes("&quot;")
    ) {
      content = content
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
    }
    return content
  }

  private removeClosingTag(block: ToolUse, tag: ToolParamName, text?: string) {
    // If block is partial, remove partial closing tag so its not presented to user
    if (!block.partial) {
      return text || ""
    }
    if (!text) {
      return ""
    }
    // This regex dynamically constructs a pattern to match the closing tag:
    // - Optionally matches whitespace before the tag
    // - Matches '<' or '</' optionally followed by any subset of characters from the tag name
    const tagRegex = new RegExp(
      `\\s?<\/?${tag
        .split("")
        .map((char) => `(?:${char})?`)
        .join("")}$`,
      "g"
    )
    return text.replace(tagRegex, "")
  }

  async askApproval(block: ToolUse, type: ClineAsk, partialMessage?: string) {
    const { response, text, images } = await this.cline.ask(type, partialMessage, false)
    if (response == "yesButtonClicked") {
      return true
    }
    if (response === "messageResponse") {
      await this.cline.say("user_feedback", text, images)
      this.cline.pushToolResult(block,
        formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images)
      )
      this.cline.didRejectTool = true
      return false
    }
    this.cline.pushToolResult(block, formatResponse.toolDenied())
    this.cline.didRejectTool = true
    return false

  }

  async handleError(block: ToolUse, action: string, error: Error) {
    const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
    await this.cline.say(
      "error",
      `Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
    )
    this.cline.pushToolResult(block, formatResponse.toolError(errorString))
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
    const sharedMessageProps: ClineSayTool = {
      tool: fileExists ? "editedExistingFile" : "newFileCreated",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relPath)),
    }

    try {
      if (block.partial) {
        // update gui message
        const partialMessage = JSON.stringify(sharedMessageProps)
        await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        // update editor
        if (!this.diffViewProvider.isEditing) {
          // open the editor and prepare to stream content in
          await this.diffViewProvider.open(relPath)
        }
        // editor is open, stream content in
        await this.diffViewProvider.update(newContent, false, this.cline.config.editAutoScroll)
        return
      }
      if (!relPath) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("write_to_file", "path"))
        await this.diffViewProvider.reset()
        return
      }
      if (!newContent) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("write_to_file", "content"))
        await this.diffViewProvider.reset()
        return
      }
      this.cline.consecutiveMistakeCount = 0

      // if isEditingFile false, that means we have the full contents of the file already.
      // it's important to note how this function works,
      // you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data.
      // So this part of the logic will always be called.
      // in other words, you must always repeat the block.partial logic here
      if (!this.diffViewProvider.isEditing) {
        // show gui message before showing edit animation
        const partialMessage = JSON.stringify(sharedMessageProps)

        // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
        await this.cline.ask("tool", partialMessage, true).catch(() => { })
        await this.diffViewProvider.open(relPath)
      }
      await this.diffViewProvider.update(newContent, true, this.cline.config.editAutoScroll)
      await delay(300) // wait for diff view to update
      this.diffViewProvider.scrollToFirstDiff()
      showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: fileExists ? undefined : newContent,
        diff: fileExists
          ? formatResponse.createPrettyPatch(
            relPath,
            this.diffViewProvider.originalContent,
            newContent
          )
          : undefined,
      } satisfies ClineSayTool)
      const didApprove = await this.askApproval(block, "tool", completeMessage)
      if (!didApprove) {
        await this.diffViewProvider.revertChanges()
        return
      }
      const { newProblemsMessage, userEdits, finalContent } = await this.diffViewProvider.saveChanges()
      this.cline.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
      if (!userEdits) {
        this.cline.pushToolResult(block, `The content was successfully saved to ${relPath.toPosix()}.${newProblemsMessage}`)
        await this.diffViewProvider.reset()
        return
      }

      const userFeedbackDiff = JSON.stringify({
        tool: fileExists ? "editedExistingFile" : "newFileCreated",
        path: getReadablePath(this.cwd, relPath),
        diff: userEdits,
      } satisfies ClineSayTool)
      await this.cline.say("user_feedback_diff", userFeedbackDiff)
      this.cline.pushToolResult(block,
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
    const sharedMessageProps: ClineSayTool = {
      tool: "readFile",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relPath)),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: undefined,
        } satisfies ClineSayTool)
        if (this.cline.config.alwaysAllowReadOnly) {
          await this.cline.say("tool", partialMessage, undefined, block.partial)
        } else {
          await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        }
        return
      }
      if (!relPath) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("read_file", "path"))
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relPath)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: absolutePath,
      } satisfies ClineSayTool)
      if (this.cline.config.alwaysAllowReadOnly) {
        // need to be sending partialValue bool
        // since undefined has its own purpose in that the message is treated neither as a partial or completion of a partial
        // but as a single complete message
        await this.cline.say("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      // Read file and check line count
      const content = await extractTextFromFile(absolutePath)
      const lineCount = content.split('\n').length

      if (lineCount > ToolExecutor.MAX_FILE_LINES) {
        // If file is too large, use listCodeDefinitionNamesTool functionality instead
        const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
        this.cline.pushToolResult(block,
          `File is too large (${lineCount} lines). Showing code definitions instead:\n\n${result}`
        )
        return
      }

      this.cline.pushToolResult(block, content)
      return

    } catch (error) {
      await this.handleError(block, "reading file", error)
      return
    }
  }

  async listFilesTool(block: ToolUse) {
    const relDirPath: string | undefined = block.params.path
    const recursiveRaw: string | undefined = block.params.recursive
    const recursive = recursiveRaw?.toLowerCase() === "true"
    const sharedMessageProps: ClineSayTool = {
      tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relDirPath)),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: "",
        } satisfies ClineSayTool)
        if (this.cline.config.alwaysAllowReadOnly) {
          await this.cline.say("tool", partialMessage, undefined, block.partial)
        } else {
          await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        }
        return
      }
      if (!relDirPath) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("list_files", "path"))
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
      const result = formatResponse.formatFilesList(absolutePath, files, didHitLimit)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies ClineSayTool)
      if (this.cline.config.alwaysAllowReadOnly) {
        await this.cline.say("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.cline.pushToolResult(block, result)
      return

    } catch (error) {
      await this.handleError(block, "listing files", error)
      return
    }
  }

  async listCodeDefinitionNamesTool(block: ToolUse) {
    const relDirPath: string | undefined = block.params.path
    const sharedMessageProps: ClineSayTool = {
      tool: "listCodeDefinitionNames",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relDirPath)),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify({
          ...sharedMessageProps,
          content: "",
        } satisfies ClineSayTool)
        if (this.cline.config.alwaysAllowReadOnly) {
          await this.cline.say("tool", partialMessage, undefined, block.partial)
        } else {
          await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        }
        return
      }
      if (!relDirPath) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block,
          await this.cline.sayAndCreateMissingParamError("list_code_definition_names", "path")
        )
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies ClineSayTool)
      if (this.cline.config.alwaysAllowReadOnly) {
        await this.cline.say("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.cline.pushToolResult(block, result)
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
    const sharedMessageProps: ClineSayTool = {
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
        } satisfies ClineSayTool)
        if (this.cline.config.alwaysAllowReadOnly) {
          await this.cline.say("tool", partialMessage, undefined, block.partial)
        } else {
          await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        }
        return
      }
      if (!relDirPath) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("search_files", "path"))
        return
      }
      if (!regex) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("search_files", "regex"))
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const absolutePath = path.resolve(this.cwd, relDirPath)
      const results = await regexSearchFiles(this.cwd, absolutePath, regex, filePattern)
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: results,
      } satisfies ClineSayTool)
      if (this.cline.config.alwaysAllowReadOnly) {
        await this.cline.say("tool", completeMessage, undefined, false)
      } else {
        const didApprove = await this.askApproval(block, "tool", completeMessage)
        if (!didApprove) {
          return
        }
      }
      this.cline.pushToolResult(block, results)
      return

    } catch (error) {
      await this.handleError(block, "searching files", error)
      return
    }
  }

  async inspectSizeTool(block: ToolUse) {
    const url: string | undefined = block.params.url
    const sharedMessageProps: ClineSayTool = {
      tool: "inspectSite",
      path: this.removeClosingTag(block, "url", url),
    }
    try {
      if (block.partial) {
        const partialMessage = JSON.stringify(sharedMessageProps)
        if (this.cline.config.alwaysAllowReadOnly) {
          await this.cline.say("tool", partialMessage, undefined, block.partial)
        } else {
          await this.cline.ask("tool", partialMessage, block.partial).catch(() => { })
        }
        return
      }
      if (!url) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("inspect_site", "url"))
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const completeMessage = JSON.stringify(sharedMessageProps)
      if (this.cline.config.alwaysAllowReadOnly) {
        await this.cline.say("tool", completeMessage, undefined, false)
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
      await this.cline.say("inspect_site_result", "")
      await this.cline.urlContentFetcher.launchBrowser()
      let result: {
        screenshot: string
        logs: string
      }
      try {
        result = await this.cline.urlContentFetcher.urlToScreenshotAndLogs(url)
      } finally {
        await this.cline.urlContentFetcher.closeBrowser()
      }
      const { screenshot, logs } = result
      await this.cline.say("inspect_site_result", logs, [screenshot])

      this.cline.pushToolResult(block,
        formatResponse.toolResult(
          `The site has been visited, with console logs captured and a screenshot taken for your analysis.\n\nConsole logs:\n${logs || "(No logs)"
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
        await this.cline.ask("command", this.removeClosingTag(block, "command", command), block.partial).catch(
          () => { }
        )
        return
      } else {
        if (!command) {
          this.cline.consecutiveMistakeCount++
          this.cline.pushToolResult(block,
            await this.cline.sayAndCreateMissingParamError("execute_command", "command")
          )
          return
        }
        this.cline.consecutiveMistakeCount = 0
        const didApprove = await this.askApproval(block, "command", command)
        if (!didApprove) {
          return
        }
        const [userRejected, result] = await this.cline.executeCommand(command)
        if (userRejected) {
          this.cline.didRejectTool = true
        }
        this.cline.pushToolResult(block, result)
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
      const lastMessage = this.cline.clineMessages.at(-1)
      if (block.partial) {
        if (command) {
          // the attempt_completion text is done, now we're getting command
          // remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

          // const secondLastMessage = this.clineMessages.at(-2)
          if (lastMessage && lastMessage.ask === "command") {
            // update command
            await this.cline.ask(
              "command",
              this.removeClosingTag(block, "command", command),
              block.partial
            ).catch(() => { })
          } else {
            // last message is completion_result
            // we have command string, which means we have the result as well, so finish it (doesnt have to exist yet)
            await this.cline.say(
              "completion_result",
              this.removeClosingTag(block, "result", result),
              undefined,
              false
            )
            await this.cline.ask(
              "command",
              this.removeClosingTag(block, "command", command),
              block.partial
            ).catch(() => { })
          }
        } else {
          // no command, still outputting partial result
          await this.cline.say(
            "completion_result",
            this.removeClosingTag(block, "result", result),
            undefined,
            block.partial
          )
        }
        return
      }
      if (!result) {
        this.cline.consecutiveMistakeCount++
        this.cline.pushToolResult(block,
          await this.cline.sayAndCreateMissingParamError("attempt_completion", "result")
        )
        return
      }
      this.cline.consecutiveMistakeCount = 0

      let commandResult: ToolResponse | undefined
      if (command) {
        if (lastMessage && lastMessage.ask !== "command") {
          // havent sent a command message yet so first send completion_result then command
          await this.cline.say("completion_result", result, undefined, false)
        }

        // complete command message
        const didApprove = await this.askApproval(block, "command", command)
        if (!didApprove) {
          return
        }
        const [userRejected, execCommandResult] = await this.cline.executeCommand(command!)
        if (userRejected) {
          this.cline.didRejectTool = true
          this.cline.pushToolResult(block, execCommandResult)
          return
        }
        // user didn't reject, but the command may have output
        commandResult = execCommandResult
      } else {
        await this.cline.say("completion_result", result, undefined, false)
      }

      // we already sent completion_result says, an empty string asks relinquishes control over button and field
      const { response, text, images } = await this.cline.ask("completion_result", "", false)
      if (response === "yesButtonClicked") {
        this.cline.pushToolResult(block, "") // signals to recursive loop to stop (for now this never happens since yesButtonClicked will trigger a new task)
        return
      }
      await this.cline.say("user_feedback", text ?? "", images)

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
      toolResults.push(...formatResponse.imageBlocks(images))
      this.cline.userMessageContent.push({
        type: "text",
        text: `$getToolDescription(block)} Result:`,
      })
      this.cline.userMessageContent.push(...toolResults)

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
        await this.cline.ask("followup", this.removeClosingTag(block, "question", question), block.partial).catch(
          () => { }
        )
        return
      }
      if (!question) {
        this.cline.consecutiveMistakeCount++
        const missingParamError = await this.cline.sayAndCreateMissingParamError("ask_followup_question", "question")
        this.cline.pushToolResult(block, missingParamError)
        return
      }
      this.cline.consecutiveMistakeCount = 0
      const { text, images } = await this.cline.ask("followup", question, false)
      await this.cline.say("user_feedback", text ?? "", images)
      this.cline.pushToolResult(block, formatResponse.toolResult(`<answer>\n${text}\n</answer>`, images))
      return

    } catch (error) {
      await this.handleError(block, "asking question", error)
      return
    }
  }

  async searchReplaceTool(block: ToolUse) {
    const contentParam: string | undefined = block.params.content
    console.debug("contentParam:", contentParam);
    if (block.partial) {
      console.debug("Block is partial, returning early.");
      return
    }

    if (!contentParam) {
      console.debug("Content parameter is missing.");
      this.cline.consecutiveMistakeCount++;
      this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("search_replace", "content"));
      return;
    }

    const content = this.cleanUpContent(contentParam);
    console.debug("Cleaned up content:", content);

    try {
      const lines = content.split('\n');
      console.debug("Content lines:", lines);

      // First non-empty line should be the file path
      const filePath = lines[0]?.trim();
      console.debug("File path:", filePath);
      if (!filePath) {
        await this.handleError(block, "performing search and replace", new Error("file path not provided"));
        return;
      }

      // Find the sections
      let searchContent = '';
      let replaceContent = '';
      let currentSection: 'none' | 'search' | 'replace' = 'none';

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        console.debug(`Processing line ${i}:`, line);

        if (line.match(/^<{5,9} SEARCH\s*$/)) {
          currentSection = 'search';
          console.debug("Entering search section.");
          continue;
        }
        if (line.match(/^={5,9}\s*$/)) {
          currentSection = 'replace';
          console.debug("Entering replace section.");
          continue;
        }
        if (line.match(/^>{5,9} REPLACE\s*$/)) {
          console.debug("End of block.");
          break; // End of block
        }

        // Add lines to appropriate section
        if (currentSection === 'search') {
          searchContent += (searchContent ? '\n' : '') + line;
          console.debug("Adding to search content:", line);
        } else if (currentSection === 'replace') {
          replaceContent += (replaceContent ? '\n' : '') + line;
          console.debug("Adding to replace content:", line);
        }
      }

      // Validate we have all required parts
      if (!searchContent || !replaceContent) {
        console.debug("Waiting for the full content to come in.");
        return
      }

      console.debug("Search content:", searchContent);
      console.debug("Replace content:", replaceContent);

      const absolutePath = path.resolve(this.cwd, filePath);
      console.debug("Absolute file path:", absolutePath);
      const originalContent = await fs.readFile(absolutePath, 'utf8');
      console.debug("Original file content:", originalContent);

      // Open the file in diff view
      const document = await vscode.workspace.openTextDocument(absolutePath);
      const editor = await vscode.window.showTextDocument(document);
      console.debug("Opened file in editor.");

      const fileContent = document.getText();
      console.debug("File content from editor:", fileContent);

      // Find the index of the content to search
      const searchIndex = fileContent.indexOf(searchContent);
      console.debug("Search content index:", searchIndex);

      if (searchIndex === -1) {
        await this.handleError(block, "couldn't find search content", new Error("search content not found in file"));
      }

      // Create positions and range for the search content
      const startPos = document.positionAt(searchIndex);
      const endPos = document.positionAt(searchIndex + searchContent.length);
      const range = new vscode.Range(startPos, endPos);
      console.debug("Range for replacement:", range);

      // Apply the replacement with the specified format
      await editor.edit(editBuilder => {
        editBuilder.insert(range.start, `<<<<<<< SEARCH\n`);
        editBuilder.insert(range.end, `\n=======\n${replaceContent}\n>>>>>>> REPLACE`);
      });
      console.debug("Applied replacement in editor.");

      // Move the cursor to the beginning of the `replaceContent`
      const dividerLength = 9; // Length of `=======\n`
      const replaceStartPos = document.positionAt(searchIndex + searchContent.length + dividerLength);
      editor.selection = new vscode.Selection(replaceStartPos, replaceStartPos);
      editor.revealRange(new vscode.Range(replaceStartPos, replaceStartPos), vscode.TextEditorRevealType.InCenter);
      console.debug("Set cursor position to the start of the replaced content.");

      const completeMessage = JSON.stringify({
        tool: "searchReplace",
        path: filePath,
        diff: formatResponse.createPrettyPatch(
          filePath,
          originalContent,
          document.getText()
        ),
      } satisfies ClineSayTool);

      const didApprove = await this.askApproval(block, "tool", completeMessage);
      if (!didApprove) {
        await this.diffViewProvider.revertChanges();
        return;
      }

      // After approval, clean up the merge conflict notation
      const fullContent = document.getText();
      const mergeStartIndex = fullContent.indexOf('<<<<<<< SEARCH\n');
      const mergeEndIndex = fullContent.indexOf('>>>>>>> REPLACE') + '>>>>>>> REPLACE'.length;

      if (mergeStartIndex !== -1 && mergeEndIndex !== -1) {
        const replaceStart = fullContent.indexOf('=======\n') + '=======\n'.length;
        const replaceEnd = fullContent.indexOf('\n>>>>>>> REPLACE');
        const cleanedReplacement = fullContent.substring(replaceStart, replaceEnd);

        await editor.edit(editBuilder => {
          const entireRange = new vscode.Range(
            document.positionAt(mergeStartIndex),
            document.positionAt(mergeEndIndex)
          );
          editBuilder.replace(entireRange, cleanedReplacement);
        });

        await document.save();
        this.cline.pushToolResult(block, `Search and replace completed successfully in ${filePath}. The merge conflict notation has been cleaned up and the replacement content has been saved.`);
        await this.diffViewProvider.reset();
        return;
      }

      // Show changes and get approval
      const { newProblemsMessage, userEdits } = await this.diffViewProvider.saveChanges();
      console.debug("Saved changes. New problems message:", newProblemsMessage, "User edits:", userEdits);
      this.cline.didEditFile = true;

      if (!userEdits) {
        this.cline.pushToolResult(block, `Search and replace completed successfully in ${filePath}.${newProblemsMessage}`);
        await this.diffViewProvider.reset();
        return;
      }

      // Handle user edits if any
      const userFeedbackDiff = JSON.stringify({
        tool: "searchReplace",
        path: filePath,
        diff: userEdits,
      } satisfies ClineSayTool);

      await this.cline.say("user_feedback_diff", userFeedbackDiff);
      this.cline.pushToolResult(block,
        `The user made the following updates:\n\n${userEdits}\n\n` +
        `Changes applied successfully to ${filePath}.${newProblemsMessage}`
      );
      await this.diffViewProvider.reset();

    } catch (error) {
      console.error("Error during search and replace:", error);
      await this.handleError(block, "performing search and replace", error);
      await this.diffViewProvider.reset();
    }
  }

  async insertCodeBlockTool(block: ToolUse) {
    console.debug("insertCodeBlockTool called with block:", block);
    const relPath: string | undefined = block.params.path;
    const position: string | undefined = block.params.position;
    const content: string | undefined = block.params.content;

    const sharedMessageProps: ClineSayTool = {
      tool: "insertCodeBlock",
      path: getReadablePath(this.cwd, this.removeClosingTag(block, "path", relPath)),
    };

    if (!content) {
      console.debug("Content is missing.");
      return;
    }

    const newContent = this.cleanUpContent(content);
    console.debug("Cleaned up content:", newContent);

    try {
      if (block.partial) {
        console.debug("Block is partial, sending partial message.");
        const partialMessage = JSON.stringify(sharedMessageProps);
        await this.cline.ask("tool", partialMessage, block.partial).catch(() => {
          console.debug("Partial message ask failed.");
        });
        return;
      }

      // Validate required parameters
      if (!relPath) {
        console.debug("Path is missing.");
        this.cline.consecutiveMistakeCount++;
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("insert_code_block", "path"));
        return;
      }
      if (!position) {
        console.debug("Position is missing.");
        this.cline.consecutiveMistakeCount++;
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("insert_code_block", "position"));
        return;
      }
      if (!content) {
        console.debug("Content is missing.");
        this.cline.consecutiveMistakeCount++;
        this.cline.pushToolResult(block, await this.cline.sayAndCreateMissingParamError("insert_code_block", "content"));
        return;
      }

      this.cline.consecutiveMistakeCount = 0;

      // Read the file
      const absolutePath = path.resolve(this.cwd, relPath);
      console.debug("Resolved absolute path:", absolutePath);
      const fileContent = await fs.readFile(absolutePath, 'utf8');
      this.diffViewProvider.editType = "modify"
      this.diffViewProvider.originalContent = fileContent;
      console.debug("Read file content:", fileContent);
      const lines = fileContent.split('\n');
      console.debug("File content split into lines:", lines);

      // Convert position to number and validate
      const lineNumber = parseInt(position);
      console.debug("Parsed line number:", lineNumber);
      if (isNaN(lineNumber) || lineNumber < 0 || lineNumber > lines.length) {
        throw new Error(`Invalid position: ${position}. Must be a number between 0 and ${lines.length}`);
      }

      // Insert the code block at the specified position
      const contentLines = content.split('\n');
      console.debug("Content split into lines:", contentLines);
      const targetLine = lineNumber - 1;
      console.debug("Target line for insertion:", targetLine);

      lines.splice(targetLine, 0, ...contentLines);
      const updatedContent = lines.join('\n');
      console.debug("New content with insertion:", updatedContent);

      // Show changes in diff view
      if (!this.diffViewProvider.isEditing) {
        console.debug("Diff view is not editing, opening diff view.");
        await this.cline.ask("tool", JSON.stringify(sharedMessageProps), true).catch(() => {
          console.debug("Diff view opening ask failed.");
        });
        // First open with original content
        await this.diffViewProvider.open(relPath);
        await this.diffViewProvider.update(fileContent, false, this.cline.config.editAutoScroll, true);
        this.diffViewProvider.scrollEditorToLine(targetLine);
        await delay(200);
      }

      console.debug("Updating diff view with new content.");
      await this.diffViewProvider.update(updatedContent, true, this.cline.config.editAutoScroll, true);

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        diff: formatResponse.createPrettyPatch(
          relPath,
          this.diffViewProvider.originalContent,
          updatedContent
        ),
      } satisfies ClineSayTool);

      console.debug("Asking for approval with complete message:", completeMessage);
      const didApprove = await this.cline.ask("tool", completeMessage, false).then(
        response => response.response === "yesButtonClicked"
      );

      if (!didApprove) {
        console.debug("Changes were not approved, reverting changes.");
        await this.diffViewProvider.revertChanges();
        this.cline.pushToolResult(block, "Changes were rejected by the user.");
        return;
      }

      console.debug("Saving changes after approval.");
      const { newProblemsMessage, userEdits, finalContent } = await this.diffViewProvider.saveChanges();
      this.cline.didEditFile = true;

      if (!userEdits) {
        console.debug("No user edits, pushing tool result.");
        this.cline.pushToolResult(
          block,
          `The code block was successfully inserted at line ${position} in ${relPath.toPosix()}.${newProblemsMessage}`
        );
        await this.diffViewProvider.reset();
        return;
      }

      const userFeedbackDiff = JSON.stringify({
        tool: "insertCodeBlock",
        path: getReadablePath(this.cwd, relPath),
        diff: userEdits,
      } satisfies ClineSayTool);

      console.debug("User made edits, sending feedback diff:", userFeedbackDiff);
      await this.cline.say("user_feedback_diff", userFeedbackDiff);
      this.cline.pushToolResult(
        block,
        `The user made the following updates to your content:\n\n${userEdits}\n\n` +
        `The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file:\n\n` +
        `<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
        `Please note:\n` +
        `1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
        `2. Proceed with the task using this updated file content as the new baseline.\n` +
        `3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
        `${newProblemsMessage}`
      );
      await this.diffViewProvider.reset();

    } catch (error) {
      console.error("Error inserting code block:", error);
      const errorString = `Error inserting code block: ${JSON.stringify(error)}`;
      await this.cline.say(
        "error",
        `Error inserting code block:\n${error.message ?? JSON.stringify(error, null, 2)}`
      );
      this.cline.pushToolResult(block, formatResponse.toolError(errorString));
      await this.diffViewProvider.reset();
    }
  }

  // Handle Tool Execution

  async handleToolUse(block: ToolUse) {
    switch (block.name) {
      case "write_to_file": {
        await this.writeToFileTool(block)
        return
      }
      case "read_file": {
        await this.readFileTool(block)
        return
      }
      case "list_files": {
        await this.listFilesTool(block)
        return
      }
      case "list_code_definition_names": {
        await this.listCodeDefinitionNamesTool(block)
        return
      }
      case "search_files": {
        await this.searchFilesTool(block)
        return
      }
      case "inspect_site": {
        await this.inspectSizeTool(block)
        return
      }
      case "execute_command": {
        await this.executeCommandTool(block)
        return
      }
      case "ask_followup_question": {
        await this.askFollowupQuestionTool(block)
        return
      }
      case "attempt_completion": {
        await this.attemptCompletionTool(block)
        return
      }
      case "search_replace": {
        await this.searchReplaceTool(block)
        return
      }
      case "insert_code_block": {
        await this.insertCodeBlockTool(block)
        return
      }
    }
  }
}
