import { Anthropic } from "@anthropic-ai/sdk"
import cloneDeep from "clone-deep"
import delay from "delay"
import fs from "fs/promises"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { APIHandler, buildApiHandler } from "../api"
import { APIStream } from "../api/types"
import { DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import { findToolName, formatContentBlockToMarkdown } from "../integrations/misc/export"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { listFiles } from "../services/glob/list-files"
import { combineApiRequests, combineCommandSequences } from "../shared/combiners"
import {
  APIConfiguration,
  APIRequestInfo,
  CodeyMessage,
  HistoryItem,
} from "../shared/interfaces"
import { getApiMetrics } from "../shared/metrics"
import { APIRequestCancelReason, CodeyAsk, CodeySay, ExtensionMessageType, UserResponse } from "../shared/types"
import { AskUserResponse, AssistantMessageContent, TextContent, ToolResponse, ToolUse, UserContent } from "../types"
import { GlobalFileNames } from "../utils/const"
import { ensureTaskDirectoryExists, fileExistsAtPath, getSavedApiConversationHistory } from "../utils/fs"
import { findLastIndex, timeAgoDescription } from "../utils/helpers"
import { arePathsEqual } from "../utils/path"
import { calculateApiCost } from "../utils/pricing"
import { AgentConfig } from "./config"
import { responseTemplates, truncateConversation } from "./formatter"
import { parseMentions } from "./mentions"
import { AgentMessageParser } from "./parser"
import { CUSTOM_USER_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompts"
import { ToolExecutor } from "./tools"
import { ViewProvider } from "./webview"


export class Agent {

  // Declarations
  api: APIHandler
  urlContentFetcher: UrlContentFetcher
  config: AgentConfig

  // State
  apiConversationHistory: Anthropic.MessageParam[] = []
  codeyMessages: CodeyMessage[] = []
  didFinishAborting = false
  abandoned = false
  consecutiveMistakeCount: number = 0
  didEditFile: boolean = false
  didRejectTool = false
  desktopPath = path.join(os.homedir(), "Desktop")
  userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
  cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? this.desktopPath

  // Task state
  readonly taskId: string
  private terminalManager: TerminalManager
  private userResponse?: UserResponse
  private userResponseText?: string
  private userResponseImages?: string[]
  private lastMessageTs?: number
  private providerRef: WeakRef<ViewProvider>
  private diffViewProvider: DiffViewProvider
  private abort: boolean = false
  private toolExecutor: ToolExecutor
  private globalStoragePath: string

  // Streaming
  private currentStreamingContentIndex = 0
  private assistantMessageContent: AssistantMessageContent[] = []
  private presentAssistantMessageLocked = false
  private presentAssistantMessageHasPendingUpdates = false
  private userMessageContentReady = false
  private didCompleteReadingStream = false

  constructor(
    provider: ViewProvider,
    apiConfiguration: APIConfiguration,
    config: AgentConfig,
    task?: string,
    images?: string[],
    historyItem?: HistoryItem,
  ) {
    this.providerRef = new WeakRef(provider)
    this.globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath ?? ""
    this.api = buildApiHandler(apiConfiguration)
    this.config = config
    this.terminalManager = new TerminalManager()
    this.urlContentFetcher = new UrlContentFetcher(provider.context)
    this.diffViewProvider = new DiffViewProvider(this.cwd)
    this.toolExecutor = new ToolExecutor(this, this.config, this.cwd, this.diffViewProvider)

    if (historyItem) {
      this.taskId = historyItem.id
      this.resumeTaskFromHistory()
    } else if (task || images) {
      this.taskId = Date.now().toString()
      this.startTask(task, images)
    } else {
      throw new Error("Either historyItem or task/images must be provided")
    }
  }

  // Persistence Methods

  /**
   * Adds a message to the API conversation history and saves the updated history to persistent storage.
   *
   * @param message - The message to be added to the conversation history.
   * @returns A promise that resolves when the conversation history has been saved.
   */
  private async addToApiConversationHistory(message: Anthropic.MessageParam) {
    this.apiConversationHistory.push(message)
    await this.saveApiConversationHistory(this.globalStoragePath, this.taskId, this.apiConversationHistory)
  }

  /**
   * Overwrites the current API conversation history with a new history.
   *
   * @param newHistory - An array of `Anthropic.MessageParam` representing the new conversation history.
   * @returns A promise that resolves once the conversation history has been saved.
   */
  private async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
    this.apiConversationHistory = newHistory
    await this.saveApiConversationHistory(this.globalStoragePath, this.taskId, this.apiConversationHistory)
  }

  /**
   * Saves the API conversation history to a specified storage path.
   *
   * @param storagePath - The path where the conversation history should be stored.
   * @param taskId - The unique identifier for the task.
   * @param history - An array of messages representing the conversation history.
   * 
   * @returns A promise that resolves when the conversation history has been successfully saved.
   * @throws Will log an error message if saving the conversation history fails.
   */
  private async saveApiConversationHistory(storagePath: string, taskId: string, history: Anthropic.Messages.MessageParam[]) {
    try {
      const dir = await ensureTaskDirectoryExists(storagePath, taskId)
      const filePath = path.join(dir, GlobalFileNames.apiConversationHistory)
      const content = JSON.stringify(history)
      await fs.writeFile(filePath, content)
    } catch (error) {
      console.error("Failed to save API conversation history:", error)
    }
  }

  /**
   * Retrieves saved Codey messages from the specified storage path and task ID.
   * 
   * This function first checks for the existence of the messages file in the current
   * directory. If the file exists, it reads and parses the JSON content. If the file
   * does not exist, it checks an old location for the messages file, reads and parses
   * the JSON content if found, and then removes the old file.
   * 
   * @param storagePath - The base path where task directories are stored.
   * @param taskId - The unique identifier for the task.
   * @returns A promise that resolves to an array of CodeyMessage objects.
   */
  private async getSavedCodeyMessages(storagePath: string, taskId: string): Promise<CodeyMessage[]> {
    const dir = await ensureTaskDirectoryExists(storagePath, taskId)
    const filePath = path.join(dir, GlobalFileNames.uiMessages)
    if (await fileExistsAtPath(filePath)) {
      return JSON.parse(await fs.readFile(filePath, "utf8"))
    }
    // check old location
    const oldDir = await ensureTaskDirectoryExists(storagePath, taskId)
    const oldPath = path.join(oldDir, "claude_messages.json")
    if (await fileExistsAtPath(oldPath)) {
      const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
      await fs.unlink(oldPath) // remove old file
      return data
    }

    return []
  }

  /**
   * Adds a message to the codeyMessages array and saves the updated array to the global storage.
   *
   * @param message - The CodeyMessage object to be added to the codeyMessages array.
   * @returns A promise that resolves when the codeyMessages array has been saved.
   */
  private async addToCodeyMessages(message: CodeyMessage) {
    this.codeyMessages.push(message)
    await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
  }

  /**
   * Overwrites the current Codey messages with new messages and saves them.
   *
   * @param newMessages - An array of new CodeyMessage objects to replace the current messages.
   * @returns A promise that resolves when the messages have been saved.
   */
  private async overwriteCodeyMessages(newMessages: CodeyMessage[]) {
    this.codeyMessages = newMessages
    await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
  }

  /**
   * Saves Codey messages to a specified storage path and updates the task history.
   *
   * @param storagePath - The path where the task directory is located.
   * @param taskId - The unique identifier of the task.
   * @param messages - An array of CodeyMessage objects to be saved.
   *
   * @throws Will log an error message if saving the messages or updating the task history fails.
   *
   * @remarks
   * This method ensures that the task directory exists, writes the messages to a file,
   * calculates API metrics, and updates the task history with relevant information.
   */
  private async saveCodeyMessages(storagePath: string, taskId: string, messages: CodeyMessage[]) {
    try {
      const dir = await ensureTaskDirectoryExists(storagePath, taskId)
      const filePath = path.join(dir, GlobalFileNames.uiMessages)
      await fs.writeFile(filePath, JSON.stringify(messages))
      const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(messages.slice(1))))
      const taskMessage = messages[0] // first message is always the task say
      const lastRelevantMessage = messages[findLastIndex(messages, (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))]
      await this.providerRef.deref()?.updateTaskHistory({
        id: taskId,
        ts: lastRelevantMessage.ts,
        task: taskMessage.text ?? "",
        tokensIn: apiMetrics.totalTokensIn,
        tokensOut: apiMetrics.totalTokensOut,
        cacheWrites: apiMetrics.totalCacheWrites,
        cacheReads: apiMetrics.totalCacheReads,
        totalCost: apiMetrics.totalCost,
      })
    } catch (error) {
      console.error("Failed to save codey messages:", error)
    }
  }

  // Webview Methods

  /**
   * Asks the user a question and waits for their response.
   * 
   * Partial has three valid states:
   *  - true (partial message)
   *  - false (completion of partial message)
   *  - undefined (individual complete message)
   * 
   * If this Codey instance was aborted by the provider, then the only thing keeping us alive is a promise still running in the background
   * in which case we don't want to send its result to the webview as it is attached to a new instance of Codey now.
   * So we can safely ignore the result of any active promises, and this class will be deallocated.
   * (Although we set Codey = undefined in provider, that simply removes the reference to this instance,
   * but the instance is still alive until this promise resolves or rejects.)
   * 
   * Bug for the history books (isUpdatingPreviousPartial):
   * In the webview we use the ts as the chatrow key for the virtuoso list. Since we would update this ts right at the end of streaming,
   * it would cause the view to flicker. The key prop has to be stable otherwise react has trouble reconciling items between renders,
   * causing unmounting and remounting of components (flickering).
   * The lesson here is if you see flickering when rendering lists, it's likely because the key prop is not stable.
   * So in this case we must make sure that the message ts is never altered after first setting it.
   * 
   * @param type - The type of question being asked.
   * @param text - Optional text of the question.
   * @param partial - Optional flag indicating if the message is partial.
   * @returns A promise that resolves to the user's response.
   * @throws An error if the Codey instance is aborted or if the current ask promise is ignored.
   */
  async askUser(type: CodeyAsk, text?: string, partial?: boolean): Promise<AskUserResponse> {
    if (this.abort) {
      throw new Error("Codey instance aborted")
    }
    let askTs: number
    if (partial !== undefined) {
      const lastMessage = this.codeyMessages.at(-1)
      const isUpdatingPreviousPartial = lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
      if (partial) {
        if (isUpdatingPreviousPartial) {
          // existing partial message, so update it
          lastMessage.text = text
          lastMessage.partial = partial
          // todo be more efficient about saving and posting only new data or one whole message at a time so ignore partial for saves,
          // and only post parts of partial message instead of whole array in new listener
          // await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
          const msg = { type: "partialMessage" as ExtensionMessageType, partialMessage: lastMessage }
          await this.providerRef.deref()?.postMessageToWebview(msg)
          throw new Error("Current ask promise was ignored 1")
        } else {
          // this is a new partial message, so add it with partial state
          askTs = Date.now()
          this.lastMessageTs = askTs
          await this.addToCodeyMessages({ ts: askTs, type: "ask", ask: type, text, partial })
          await this.providerRef.deref()?.postStateToWebview()
          throw new Error("Current ask promise was ignored 2")
        }
      } else {
        // partial=false means its a complete version of a previously partial message
        if (isUpdatingPreviousPartial) {
          // this is the complete version of a previously partial message, so replace the partial with the complete version
          await this.resetUserResponse()
          askTs = lastMessage.ts
          this.lastMessageTs = askTs
          lastMessage.text = text
          lastMessage.partial = false
          await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
          const msg = { type: "partialMessage" as ExtensionMessageType, partialMessage: lastMessage }
          await this.providerRef.deref()?.postMessageToWebview(msg)
        } else {
          // this is a new partial=false message, so add it like normal
          await this.resetUserResponse()
          askTs = Date.now()
          this.lastMessageTs = askTs
          await this.addToCodeyMessages({ ts: askTs, type: "ask", ask: type, text })
          await this.providerRef.deref()?.postStateToWebview()
        }
      }
    } else {
      // this is a new non-partial message, so add it like normal
      // const lastMessage = this.codeyMessages.at(-1)
      await this.resetUserResponse()
      askTs = Date.now()
      this.lastMessageTs = askTs
      await this.addToCodeyMessages({ ts: askTs, type: "ask", ask: type, text })
      await this.providerRef.deref()?.postStateToWebview()
    }

    await pWaitFor(() => this.userResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
    if (this.lastMessageTs !== askTs) {
      // could happen if we send multiple asks in a row i.e. with command_output.
      // It's important that when we know an ask could fail, it is handled gracefully
      throw new Error("Current ask promise was ignored")
    }
    const result = { response: this.userResponse!, text: this.userResponseText, images: this.userResponseImages }
    await this.resetUserResponse()
    return result
  }

  /**
   * Resets the user's response data by setting the userResponse, 
   * userResponseText, and userResponseImages properties to undefined.
   * 
   * @returns {Promise<void>} A promise that resolves when the reset is complete.
   */
  async resetUserResponse(): Promise<void> {
    this.userResponse = undefined
    this.userResponseText = undefined
    this.userResponseImages = undefined
  }

  /**
   * Handles the user response from a webview.
   *
   * @param response - The user's response object.
   * @param text - Optional text provided by the user.
   * @param images - Optional array of image URLs provided by the user.
   * @returns A promise that resolves when the user response has been handled.
   */
  async handleWebviewUserResponse(response: UserResponse, text?: string, images?: string[]) {
    this.userResponse = response
    this.userResponseText = text
    this.userResponseImages = images
  }

  async sendMessage(type: CodeySay, text?: string, images?: string[], partial?: boolean): Promise<undefined> {
    if (this.abort) {
      throw new Error("Codey instance aborted")
    }

    if (partial === undefined) {
      // this is a new non-partial message, so add it like normal
      const sayTs = Date.now()
      this.lastMessageTs = sayTs
      await this.addToCodeyMessages({ ts: sayTs, type: "say", say: type, text, images })
      await this.providerRef.deref()?.postStateToWebview()
      return
    }

    const lastMessage = this.codeyMessages.at(-1)
    const isUpdatingPreviousPartial = lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

    if (partial && isUpdatingPreviousPartial) {
      // existing partial message, so update it
      lastMessage.text = text
      lastMessage.images = images
      lastMessage.partial = partial
      const msg = { type: "partialMessage" as ExtensionMessageType, partialMessage: lastMessage }
      await this.providerRef.deref()?.postMessageToWebview(msg)
      return
    }

    if (partial && !isUpdatingPreviousPartial) {
      // this is a new partial message, so add it with partial state
      const sayTs = Date.now()
      this.lastMessageTs = sayTs
      await this.addToCodeyMessages({ ts: sayTs, type: "say", say: type, text, images, partial })
      await this.providerRef.deref()?.postStateToWebview()
      return
    }

    // partial=false means its a complete version of a previously partial message
    if (!partial && isUpdatingPreviousPartial) {
      // this is the complete version of a previously partial message, so replace the partial with the complete version
      this.lastMessageTs = lastMessage.ts
      lastMessage.text = text
      lastMessage.images = images
      lastMessage.partial = false

      // instead of streaming partialMessage events, we do a save and post like normal to persist to disk
      await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
      const msg = { type: "partialMessage" as ExtensionMessageType, partialMessage: lastMessage }
      await this.providerRef.deref()?.postMessageToWebview(msg)
      return
    }

    // this is a new partial=false message, so add it like normal
    const sayTs = Date.now()
    this.lastMessageTs = sayTs
    await this.addToCodeyMessages({ ts: sayTs, type: "say", say: type, text, images })
    await this.providerRef.deref()?.postStateToWebview()
    return
  }

  // Tasks

  private async startTask(task?: string, images?: string[]): Promise<void> {
    // conversationHistory (for API) and codeyMessages (for webview) need to be in sync
    // if the extension process were killed, then on restart the codeyMessages might not be empty, so we need to set it to [] when we create a new Codey client (otherwise webview would show stale messages from previous session)
    this.codeyMessages = []
    this.apiConversationHistory = []
    await this.providerRef.deref()?.postStateToWebview()

    await this.sendMessage("text", task, images)

    let imageBlocks: Anthropic.ImageBlockParam[] = responseTemplates.imageBlocks(images)
    await this.initiateTaskLoop([
      {
        type: "text",
        text: `<task>\n${task}\n</task>`,
      },
      ...imageBlocks,
    ])
  }

  private async resumeTaskFromHistory() {
    const modifiedCodeyMessages = await this.getSavedCodeyMessages(this.globalStoragePath, this.taskId)

    // Remove any resume messages that may have been added before
    const lastRelevantMessageIndex = findLastIndex(
      modifiedCodeyMessages,
      (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
    )
    if (lastRelevantMessageIndex !== -1) {
      modifiedCodeyMessages.splice(lastRelevantMessageIndex + 1)
    }

    // since we don't use api_req_finished anymore
    // we need to check if the last api_req_started has a cost value,
    // if it doesn't and no cancellation reason to present,
    // then we remove it since it indicates an api request without any partial content streamed
    const lastApiReqStartedIndex = findLastIndex(
      modifiedCodeyMessages,
      (m) => m.type === "say" && m.say === "api_req_started"
    )
    if (lastApiReqStartedIndex !== -1) {
      const lastApiReqStarted = modifiedCodeyMessages[lastApiReqStartedIndex]
      const { cost, cancelReason }: APIRequestInfo = JSON.parse(lastApiReqStarted.text || "{}")
      if (cost === undefined && cancelReason === undefined) {
        modifiedCodeyMessages.splice(lastApiReqStartedIndex, 1)
      }
    }

    await this.overwriteCodeyMessages(modifiedCodeyMessages)
    this.codeyMessages = await this.getSavedCodeyMessages(this.globalStoragePath, this.taskId)

    // Now present the codey messages to the user and ask if they want to resume

    const lastCodeyMessage = this.codeyMessages
      .slice()
      .reverse()
      .find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // could be multiple resume tasks

    let askType: CodeyAsk
    if (lastCodeyMessage?.ask === "completion_result") {
      askType = "resume_completed_task"
    } else {
      askType = "resume_task"
    }

    const { response, text, images } = await this.askUser(askType) // calls poststatetowebview
    let responseText: string | undefined
    let responseImages: string[] | undefined
    if (response === "messageResponse") {
      await this.sendMessage("user_feedback", text, images)
      responseText = text
      responseImages = images
    }

    // need to make sure that the api conversation history can be resumed by the api, even if it goes out of sync with codey messages

    let existingApiConversationHistory: Anthropic.Messages.MessageParam[] =
      await getSavedApiConversationHistory(this.globalStoragePath, this.taskId)

    // v2.0 xml tags refactor caveat: since we don't use tools anymore, we need to replace all tool use blocks with a text block since the API disallows conversations with tool uses and no tool schema
    const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
      if (Array.isArray(message.content)) {
        const newContent = message.content.map((block) => {
          if (block.type === "tool_use") {
            // it's important we convert to the new tool schema format so the model doesn't get confused about how to invoke tools
            const inputAsXml = Object.entries(block.input as Record<string, string>)
              .map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
              .join("\n")
            return {
              type: "text",
              text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
            } as Anthropic.Messages.TextBlockParam
          }
          if (block.type === "tool_result") {
            // Convert block.content to text block array, removing images
            const contentAsTextBlocks = Array.isArray(block.content)
              ? block.content.filter((item) => item.type === "text")
              : [{ type: "text", text: block.content }]
            const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
            const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
            return {
              type: "text",
              text: `[${toolName} Result]\n\n${textContent}`,
            } as Anthropic.Messages.TextBlockParam
          }
          return block
        })
        return { ...message, content: newContent }
      }
      return message
    })
    existingApiConversationHistory = conversationWithoutToolBlocks

    let modifiedOldUserContent: UserContent // either the last message if its user message, or the user message before the last (assistant) message
    let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[] // need to remove the last user message to replace with new modified user message

    if (existingApiConversationHistory.length <= 0) {
      throw new Error("Unexpected: No existing API conversation history")
    }

    const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

    if (lastMessage.role === "assistant") {
      const content = Array.isArray(lastMessage.content) ? lastMessage.content : [{ type: "text", text: lastMessage.content }]
      const hasToolUse = content.some((block) => block.type === "tool_use")

      if (hasToolUse) {
        const toolUseBlocks = content.filter((block) => block.type === "tool_use") as Anthropic.Messages.ToolUseBlock[]
        const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Task was interrupted before this tool call could be completed.",
        }))
        modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
        modifiedOldUserContent = [...toolResponses]
      } else {
        modifiedApiConversationHistory = [...existingApiConversationHistory]
        modifiedOldUserContent = []
      }
    } else if (lastMessage.role === "user") {
      const previousAssistantMessage: Anthropic.Messages.MessageParam | undefined =
        existingApiConversationHistory[existingApiConversationHistory.length - 2]

      const existingUserContent: UserContent = Array.isArray(lastMessage.content)
        ? lastMessage.content
        : [{ type: "text", text: lastMessage.content }]
      if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
        const assistantContent = Array.isArray(previousAssistantMessage.content)
          ? previousAssistantMessage.content
          : [{ type: "text", text: previousAssistantMessage.content }]

        const toolUseBlocks = assistantContent.filter(
          (block) => block.type === "tool_use"
        ) as Anthropic.Messages.ToolUseBlock[]

        if (toolUseBlocks.length > 0) {
          const existingToolResults = existingUserContent.filter(
            (block) => block.type === "tool_result"
          ) as Anthropic.ToolResultBlockParam[]

          const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
            .filter(
              (toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id)
            )
            .map((toolUse) => ({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Task was interrupted before this tool call could be completed.",
            }))

          modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
          modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
        } else {
          modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
          modifiedOldUserContent = [...existingUserContent]
        }
      } else {
        modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
        modifiedOldUserContent = [...existingUserContent]
      }
    } else {
      throw new Error("Unexpected: Last message is not a user or assistant message")
    }

    let newUserContent: UserContent = [...modifiedOldUserContent]

    const agoText = timeAgoDescription(lastCodeyMessage?.ts ?? Date.now())
    const wasRecent = lastCodeyMessage?.ts && Date.now() - lastCodeyMessage.ts < 30_000

    newUserContent.push({
      type: "text",
      text:
        `[TASK RESUMPTION] This task was interrupted ${agoText}. It may or may not be complete, so please reassess the task context. Be aware that the project state may have changed since then. The current working directory is now '${this.cwd.toPosix()}'. If the task has not been completed, retry the last step before interruption and proceed with completing the task.\n\nNote: If you previously attempted a tool use that the user did not provide a result for, you should assume the tool use was not successful and assess whether you should retry.${wasRecent
          ? "\n\nIMPORTANT: If the last tool use was a write_to_file that was interrupted, the file was reverted back to its original state before the interrupted edit, and you do NOT need to re-read the file as you already have its up-to-date contents."
          : ""
        }` +
        (responseText
          ? `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`
          : ""),
    })

    if (responseImages && responseImages.length > 0) {
      newUserContent.push(...responseTemplates.imageBlocks(responseImages))
    }

    await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
    await this.initiateTaskLoop(newUserContent)
  }

  private async initiateTaskLoop(userContent: UserContent): Promise<void> {
    let nextUserContent = userContent
    let includeFileDetails = true
    while (!this.abort) {
      const didEndLoop = await this.recursivelyMakeCodeyRequests(nextUserContent, includeFileDetails)
      includeFileDetails = false // we only need file details the first time

      //  The way this agentic loop works is that codey will be given a task that he then calls tools to complete.
      // unless there's an attempt_completion call, we keep responding back to him with his tool's responses until
      // he either attempt_completion or does not use anymore tools. If he does not use anymore tools,
      // we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.
      // There is a MAX_REQUESTS_PER_TASK limit to prevent infinite requests, but Codey is prompted to finish the task as efficiently as he can.
      // const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
      if (didEndLoop) {
        // For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
        //this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
        break
      } else {
        // this.say(
        // 	"tool",
        // 	"Codey responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
        // )
        nextUserContent = [
          {
            type: "text",
            text: responseTemplates.noToolsUsed(),
          },
        ]
        this.consecutiveMistakeCount++
      }
    }
  }

  abortTask() {
    this.abort = true // will stop any autonomously running promises
    this.terminalManager.disposeAll()
    this.urlContentFetcher.closeBrowser()
  }

  pushToolResult = (block: ToolUse, content: ToolResponse) => {
    this.userMessageContent.push({
      type: "text",
      text: `${this.getToolDescription(block)} Result:`,
    })
    if (typeof content === "string") {
      this.userMessageContent.push({
        type: "text",
        text: content || "(tool did not return anything)",
      })
    } else {
      this.userMessageContent.push(...content)
    }
  }

  getToolDescription = (block: ToolUse) => {
    switch (block.name) {
      case "execute_command":
        return `[${block.name} for '${block.params.command}']`
      case "read_file":
        return `[${block.name} for '${block.params.path}']`
      case "write_to_file":
        return `[${block.name} for '${block.params.path}']`
      case "search_files":
        return `[${block.name} for '${block.params.regex}'${block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
          }]`
      case "list_files":
        return `[${block.name} for '${block.params.path}']`
      case "list_code_definition_names":
        return `[${block.name} for '${block.params.path}']`
      case "inspect_site":
        return `[${block.name} for '${block.params.url}']`
      case "ask_followup_question":
        return `[${block.name} for '${block.params.question}']`
      case "attempt_completion":
        return `[${block.name}]`
      case "search_replace":
        return `[${block.name}]`
      case "insert_code_block":
        return `[${block.name}]`
    }
  }

  // Utils

  async executeCommand(command: string): Promise<[boolean, ToolResponse]> {
    const terminalInfo = await this.terminalManager.getOrCreateTerminal(this.cwd)
    terminalInfo.terminal.show() // weird visual bug when creating new terminals (even manually) where there's an empty space at the top.
    const process = this.terminalManager.runCommand(terminalInfo, command)

    let userFeedback: { text?: string; images?: string[] } | undefined
    let didContinue = false
    const sendCommandOutput = async (line: string): Promise<void> => {
      try {
        const { response, text, images } = await this.askUser("command_output", line)
        if (response === "yesButtonClicked") {
          // proceed while running
        } else {
          userFeedback = { text, images }
        }
        didContinue = true
        process.continue() // continue past the await
      } catch {
        // This can only happen if this ask promise was ignored, so ignore this error
      }
    }

    let result = ""
    process.on("line", (line) => {
      result += line + "\n"
      if (!didContinue) {
        sendCommandOutput(line)
      } else {
        this.sendMessage("command_output", line)
      }
    })

    let completed = false
    process.once("completed", () => {
      completed = true
    })

    process.once("no_shell_integration", async () => {
      await this.sendMessage("shell_integration_warning")
    })

    await process

    // Wait for a short delay to ensure all messages are sent to the webview
    // This delay allows time for non-awaited promises to be created and
    // for their associated messages to be sent to the webview, maintaining
    // the correct order of messages (although the webview is smart about
    // grouping command_output messages despite any gaps anyways)
    await delay(50)

    result = result.trim()

    if (userFeedback) {
      await this.sendMessage("user_feedback", userFeedback.text, userFeedback.images)
      return [
        true,
        responseTemplates.toolResult(
          `Command is still running in the user's terminal.${result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
          }\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
          userFeedback.images
        ),
      ]
    }

    if (!completed) {
      return [
        false,
        `Command is still running in the user's terminal.${result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
        }\n\nYou will be updated on the terminal status and new output in the future.`,
      ]
    }

    return [false, `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`]
  }

  async getEnvironmentDetails(includeFileDetails: boolean = false) {
    let details = ""

    // It could be useful for codey to know if the user went from one or no file to another between messages, so we always include this context
    details += "\n\n# VSCode Visible Files"
    const visibleFiles = vscode.window.visibleTextEditors
      ?.map((editor) => editor.document?.uri?.fsPath)
      .filter(Boolean)
      .map((absolutePath) => path.relative(this.cwd, absolutePath).toPosix())
      .join("\n")
    if (visibleFiles) {
      details += `\n${visibleFiles}`
    } else {
      details += "\n(No visible files)"
    }

    details += "\n\n# VSCode Open Tabs"
    const openTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
      .filter(Boolean)
      .map((absolutePath) => path.relative(this.cwd, absolutePath).toPosix())
      .join("\n")
    if (openTabs) {
      details += `\n${openTabs}`
    } else {
      details += "\n(No open tabs)"
    }

    const busyTerminals = this.terminalManager.getTerminals(true)
    const inactiveTerminals = this.terminalManager.getTerminals(false)

    if (busyTerminals.length > 0 && this.didEditFile) {
      //  || this.didEditFile
      await delay(300) // delay after saving file to let terminals catch up
    }

    // let terminalWasBusy = false
    if (busyTerminals.length > 0) {
      // wait for terminals to cool down
      // terminalWasBusy = allTerminals.some((t) => this.terminalManager.isProcessHot(t.id))
      await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
        interval: 100,
        timeout: 15_000,
      }).catch(() => { })
    }

    // reset, this lets us know when to wait for saved files to update terminals
    this.didEditFile = false

    // waiting for updated diagnostics lets terminal output be the most up-to-date possible
    let terminalDetails = ""

    if (busyTerminals.length > 0) {
      // terminals are cool, let's retrieve their output
      terminalDetails += "\n\n# Actively Running Terminals"
      for (const busyTerminal of busyTerminals) {
        terminalDetails += `\n## Original command: \`${busyTerminal.lastCommand}\``
        const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
        if (newOutput) {
          terminalDetails += `\n### New Output\n${newOutput}`
        } else {
          // details += `\n(Still running, no new output)` // don't want to show this right after running the command
        }
      }
    }

    // only show inactive terminals if there's output to show
    if (inactiveTerminals.length > 0) {
      const inactiveTerminalOutputs = new Map<number, string>()
      for (const inactiveTerminal of inactiveTerminals) {
        const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
        if (newOutput) {
          inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
        }
      }
      if (inactiveTerminalOutputs.size > 0) {
        terminalDetails += "\n\n# Inactive Terminals"
        for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
          const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
          if (inactiveTerminal) {
            terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
            terminalDetails += `\n### New Output\n${newOutput}`
          }
        }
      }
    }

    if (terminalDetails) {
      details += terminalDetails
    }

    if (includeFileDetails) {
      details += `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
      const isDesktop = arePathsEqual(this.cwd, path.join(os.homedir(), "Desktop"))
      if (isDesktop) {
        // don't want to immediately access desktop since it would show permission popup
        details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
      } else {
        const [files, didHitLimit] = await listFiles(this.cwd, true, this.config.directoryContextMaxLines)
        const result = responseTemplates.formatFilesList(this.cwd, files, didHitLimit)
        details += result
      }
    }

    return `<environment_details>\n${details.trim()}\n</environment_details>`
  }

  async loadContext(userContent: UserContent, includeFileDetails: boolean = false) {
    return await Promise.all([
      // Process userContent array, which contains various block types:
      // TextBlockParam, ImageBlockParam, ToolUseBlockParam, and ToolResultBlockParam.
      // We need to apply parseMentions() to:
      // 1. All TextBlockParam's text (first user message with task)
      // 2. ToolResultBlockParam's content/context text arrays if it contains "<feedback>" (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions)
      Promise.all(
        userContent.map(async (block) => {
          if (block.type === "text") {
            return {
              ...block,
              text: await parseMentions(block.text, this.cwd, this.urlContentFetcher),
            }
          } else if (block.type === "tool_result") {
            const isUserMessage = (text: string) => text.includes("<feedback>") || text.includes("<answer>")
            if (typeof block.content === "string" && isUserMessage(block.content)) {
              return {
                ...block,
                content: await parseMentions(block.content, this.cwd, this.urlContentFetcher),
              }
            } else if (Array.isArray(block.content)) {
              const parsedContent = await Promise.all(
                block.content.map(async (contentBlock) => {
                  if (contentBlock.type === "text" && isUserMessage(contentBlock.text)) {
                    return {
                      ...contentBlock,
                      text: await parseMentions(contentBlock.text, this.cwd, this.urlContentFetcher),
                    }
                  }
                  return contentBlock
                })
              )
              return {
                ...block,
                content: parsedContent,
              }
            }
          }
          return block
        })
      ),
      this.getEnvironmentDetails(includeFileDetails),
    ])
  }

  /**
   * Attempts to make an API request and handle the response as an asynchronous iterable stream.
   * If the previous API request's token usage is close to the context window limit, it truncates
   * the conversation history to free up space for the new request.
   * 
   * If the API request fails on the first chunk, it prompts the user to retry the request.
   * This will be handled differently (`api_req_falied`) as it asks the user to retry the request.
   * 
   * @param previousApiReqIndex - The index of the previous API request in the conversation history.
   * @yields {APIStream} - An asynchronous iterable stream of API response chunks.
   * @throws {Error} - Throws an error if the API request fails on the first chunk and the user does not choose to retry.
   */
  async * attemptApiRequest(previousApiReqIndex: number): APIStream {
    const supportsImages = this.api.getModel().info.supportsImages ?? false
    let systemPrompt = SYSTEM_PROMPT(this.cwd, supportsImages)
    if (this.config.customInstructions && this.config.customInstructions.trim()) {
      systemPrompt += CUSTOM_USER_INSTRUCTIONS(this.config.customInstructions)
    }

    if (previousApiReqIndex >= 0) {
      const previousRequest = this.codeyMessages[previousApiReqIndex]
      if (previousRequest && previousRequest.text) {
        const { tokensIn, tokensOut, cacheWrites, cacheReads }: APIRequestInfo = JSON.parse(previousRequest.text)
        const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
        const contextWindow = this.api.getModel().info.contextWindow || 128_000
        const maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8)
        if (totalTokens >= maxAllowedSize) {
          const truncatedMessages = truncateConversation(this.apiConversationHistory)
          await this.overwriteApiConversationHistory(truncatedMessages)
        }
      }
    }

    const stream = this.api.createMessage(systemPrompt, this.apiConversationHistory)
    const iterator = stream[Symbol.asyncIterator]()

    try {
      const firstChunk = await iterator.next()
      yield firstChunk.value
    } catch (error) {
      const { response } = await this.askUser("api_req_failed", error.message ?? JSON.stringify(serializeError(error), null, 2))
      if (response !== "yesButtonClicked") {
        throw new Error("API request failed")
      }
      await this.sendMessage("api_req_retried")
      yield* this.attemptApiRequest(previousApiReqIndex)
      return
    }

    yield* iterator
  }

  async recursivelyMakeCodeyRequests(
    userContent: UserContent,
    includeFileDetails: boolean = false
  ): Promise<boolean> {
    if (this.abort) {
      throw new Error("Codey instance aborted")
    }

    if (this.consecutiveMistakeCount >= 3) {
      const { response, text, images } = await this.askUser(
        "mistake_limit_reached",
        this.api.getModel().id.includes("claude")
          ? `This may indicate a failure in his thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
          : "Codey uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 3.5 Sonnet for its advanced agentic coding capabilities."
      )
      if (response === "messageResponse") {
        userContent.push(
          ...[
            {
              type: "text",
              text: responseTemplates.tooManyMistakes(text),
            } as Anthropic.Messages.TextBlockParam,
            ...responseTemplates.imageBlocks(images),
          ]
        )
      }
      this.consecutiveMistakeCount = 0
    }

    // get previous api req's index to check token usage and determine if we need to truncate conversation history
    const previousApiReqIndex = findLastIndex(this.codeyMessages, (m) => m.say === "api_req_started")

    // getting verbose details is an expensive operation, it uses globby to top-down build file structure of project
    // which for large projects can take a few seconds
    // for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
    await this.sendMessage(
      "api_req_started",
      JSON.stringify({
        request:
          userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
      })
    )

    const [parsedUserContent, environmentDetails] = await this.loadContext(userContent, includeFileDetails)
    userContent = parsedUserContent
    userContent.push({ type: "text", text: environmentDetails })

    await this.addToApiConversationHistory({ role: "user", content: userContent })

    // since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request
    // (to load potential details for example), we need to update the text of that message
    const lastApiReqIndex = findLastIndex(this.codeyMessages, (m) => m.say === "api_req_started")
    this.codeyMessages[lastApiReqIndex].text = JSON.stringify({
      request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
    } satisfies APIRequestInfo)
    await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
    await this.providerRef.deref()?.postStateToWebview()

    try {
      let cacheWriteTokens = 0
      let cacheReadTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let totalCost: number | undefined

      // update api_req_started. we can't use api_req_finished anymore since it's a unique case where it could come after a streaming message
      // (ie in the middle of being updated or executed)
      // fortunately api_req_finished was always parsed out for the gui anyways,
      // so it remains solely for legacy purposes to keep track of prices in tasks from history
      // (it's worth removing a few months from now)
      const updateApiReqMsg = (cancelReason?: APIRequestCancelReason, streamingFailedMessage?: string) => {
        const calculatedCost = calculateApiCost(
          this.api.getModel().info,
          inputTokens,
          outputTokens,
          cacheWriteTokens,
          cacheReadTokens
        )

        this.codeyMessages[lastApiReqIndex].text = JSON.stringify({
          ...JSON.parse(this.codeyMessages[lastApiReqIndex].text || "{}"),
          tokensIn: inputTokens,
          tokensOut: outputTokens,
          cacheWrites: cacheWriteTokens,
          cacheReads: cacheReadTokens,
          cost: totalCost ?? calculatedCost,
          cancelReason,
          streamingFailedMessage,
        } satisfies APIRequestInfo)
      }

      const abortStream = async (cancelReason: APIRequestCancelReason, streamingFailedMessage?: string) => {
        if (this.diffViewProvider.isEditing) {
          await this.diffViewProvider.revertChanges() // closes diff view
        }

        // if last message is a partial we need to update and save it
        const lastMessage = this.codeyMessages.at(-1)
        if (lastMessage && lastMessage.partial) {
          // lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
          lastMessage.partial = false
          // instead of streaming partialMessage events, we do a save and post like normal to persist to disk
          console.debug("[DEBUG] Updating partial message", lastMessage)
          // await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
        }

        // Let assistant know their response was interrupted for when task is resumed
        const cancelMessage = cancelReason === "streaming_failed" ? "[Response interrupted by API Error]" : "[Response interrupted by user]"
        await this.addToApiConversationHistory({
          role: "assistant",
          content: [{
            type: "text",
            text: assistantMessage + `\n\n` + cancelMessage
          }],
        })

        // update api_req_started to have cancelled and cost, so that we can display the cost of the partial stream
        updateApiReqMsg(cancelReason, streamingFailedMessage)
        await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)

        // signals to provider that it can retrieve the saved messages from disk, as abortTask can not be awaited on in nature
        this.didFinishAborting = true
      }

      // reset streaming state
      this.currentStreamingContentIndex = 0
      this.assistantMessageContent = []
      this.didCompleteReadingStream = false
      this.userMessageContent = []
      this.userMessageContentReady = false
      this.didRejectTool = false
      this.presentAssistantMessageLocked = false
      this.presentAssistantMessageHasPendingUpdates = false
      await this.diffViewProvider.reset()

      // yields only if the first chunk is successful, otherwise will allow the user to retry the request
      // (most likely due to rate limit error, which gets thrown on the first chunk)
      const stream = this.attemptApiRequest(previousApiReqIndex)
      let assistantMessage = ""
      try {
        for await (const chunk of stream) {
          switch (chunk.type) {
            case "usage":
              inputTokens += chunk.inputTokens
              outputTokens += chunk.outputTokens
              cacheWriteTokens += chunk.cacheWriteTokens ?? 0
              cacheReadTokens += chunk.cacheReadTokens ?? 0
              totalCost = chunk.totalCost
              break
            case "text":
              assistantMessage += chunk.text
              const prevLength = this.assistantMessageContent.length
              this.assistantMessageContent = AgentMessageParser.parse(assistantMessage)
              if (this.assistantMessageContent.length > prevLength) {
                this.userMessageContentReady = false
              }
              this.handleAssistantMessage()
              break
          }

          if (this.abort) {
            console.log("aborting stream...")
            if (!this.abandoned) {
              // only need to gracefully abort if this instance isn't abandoned (sometimes openrouter stream hangs,
              // in which case this would affect future instances of codey)
              await abortStream("user_cancelled")
            }
            break // aborts the stream
          }

          if (this.didRejectTool) {
            // userContent has a tool rejection, so interrupt the assistant's response to present the user's feedback
            assistantMessage += "\n\n[Response interrupted by user feedback]"
            // instead of setting this premptively, we allow the present iterator to finish and set userMessageContentReady when its ready
            // this.userMessageContentReady = true
            break
          }
        }
      } catch (error) {
        // abandoned happens when extension is no longer waiting for the codey instance to finish aborting
        // (error is thrown here when any function in the for loop throws due to this.abort)
        if (!this.abandoned) {
          // if the stream failed, there's various states the task could be in
          // (i.e. could have streamed some tools the user may have executed), so we just resort to replicating a cancel task
          this.abortTask()
          await abortStream(
            "streaming_failed",
            error.message ?? JSON.stringify(serializeError(error), null, 2)
          )
          const history = await this.providerRef.deref()?.getTaskWithId(this.taskId)
          if (history) {
            await this.providerRef.deref()?.initCodeyWithHistoryItem(history.historyItem)
            // await this.providerRef.deref()?.postStateToWebview()
          }
        }
      }

      if (this.abort) {
        throw new Error("Codey instance aborted")
      }

      this.didCompleteReadingStream = true

      // set any blocks to be complete to allow presentAssistantMessage to finish and set userMessageContentReady to true
      // (could be a text block that had no subsequent tool uses, or a text block at the very end, or an invalid tool use, etc.
      // whatever the case, presentAssistantMessage relies on these blocks either to be completed
      // or the user to reject a block in order to proceed and eventually set userMessageContentReady to true)
      const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
      partialBlocks.forEach((block) => {
        block.partial = false
      })
      // this.assistantMessageContent.forEach((e) => (e.partial = false)) // cant just do this bc a tool could be in the middle of executing ()
      if (partialBlocks.length > 0) {
        // if there is content to update then it will complete and update this.userMessageContentReady to true,
        // which we pwaitfor before making the next request.
        // all this is really doing is presenting the last partial message that we just set to complete
        this.handleAssistantMessage()
      }

      updateApiReqMsg()
      await this.saveCodeyMessages(this.globalStoragePath, this.taskId, this.codeyMessages)
      await this.providerRef.deref()?.postStateToWebview()

      // now add to apiconversationhistory
      // need to save assistant responses to file before proceeding to tool use since user can exit at any moment
      // and we wouldn't be able to save the assistant's response
      let didEndLoop = false
      if (assistantMessage.length > 0) {
        await this.addToApiConversationHistory({
          role: "assistant",
          content: [{ type: "text", text: assistantMessage }],
        })

        // NOTE: this comment is here for future reference - this was a workaround for userMessageContent not getting set to true.
        // It was due to it not recursively calling for partial blocks when didRejectTool,
        // so it would get stuck waiting for a partial block to complete before it could continue.
        // in case the content blocks finished
        // it may be the api stream finished after the last parsed content block was executed,
        // so  we are able to detect out of bounds and set userMessageContentReady to true
        // (note you should not call presentAssistantMessage since if the last block is completed it will be presented again)
        // const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // if there are any partial blocks after the stream ended we can consider them invalid
        // if (this.currentStreamingContentIndex >= completeBlocks.length) {
        // 	this.userMessageContentReady = true
        // }

        await pWaitFor(() => this.userMessageContentReady)

        // if the model did not tool use, then we need to tell it to either use a tool or attempt_completion
        const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")
        if (!didToolUse) {
          this.userMessageContent.push({
            type: "text",
            text: responseTemplates.noToolsUsed(),
          })
          this.consecutiveMistakeCount++
        }

        const recDidEndLoop = await this.recursivelyMakeCodeyRequests(this.userMessageContent)
        didEndLoop = recDidEndLoop
      } else {
        // if there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
        await this.sendMessage(
          "error",
          "Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output."
        )
        await this.addToApiConversationHistory({
          role: "assistant",
          content: [{ type: "text", text: "Failure: I did not provide a response." }],
        })
      }
      // will always be false for now
      return didEndLoop
    } catch (error) {
      // this should never happen since the only thing that can throw an error is the attemptApiRequest,
      // which is wrapped in a try catch that sends an ask where if noButtonClicked,
      // will clear current task and destroy this instance.
      // However to avoid unhandled promise rejection,
      // we will end this loop which will end execution of this instance (see startTask)
      return true // needs to be true so parent loop knows to end task
    }
  }

  // Main

  async handleAssistantMessage() {
    if (this.abort) {
      throw new Error("Codey instance aborted")
    }

    if (this.presentAssistantMessageLocked) {
      this.presentAssistantMessageHasPendingUpdates = true
      return
    }

    this.presentAssistantMessageLocked = true
    this.presentAssistantMessageHasPendingUpdates = false

    if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
      // this may happen if the last content block was completed before streaming could finish.
      // if streaming is finished, and we're out of bounds then this means we already presented/executed
      // the last content block and are ready to continue to next request
      if (this.didCompleteReadingStream) {
        this.userMessageContentReady = true
      }
      this.presentAssistantMessageLocked = false
      return
    }

    // need to create copy bc while stream is updating the array, it could be updating the reference block properties too
    const block = cloneDeep(this.assistantMessageContent[this.currentStreamingContentIndex])
    switch (block.type) {
      case "text": {
        await this.handleTextBlock(block)
        break
      }
      case "tool_use":
        await this.handleToolUseBlock(block)
        break
    }

    /*
    Seeing out of bounds is fine, it means that the next too call is being built up and ready to add to assistantMessageContent to present. 
    When you see the UI inactive during this, it means that a tool is breaking without presenting any UI.
    For example the write_to_file tool was breaking when relpath was undefined, and for invalid relpath it never presented UI.
    This needs to be placed here, if not then calling this.presentAssistantMessage below would fail (sometimes) since it's locked
    */
    this.presentAssistantMessageLocked = false
    // NOTE: when tool is rejected, iterator stream is interrupted and it waits for userMessageContentReady to be true.
    // Future calls to present will skip execution since didRejectTool and iterate until contentIndex is set to message
    // length and it sets userMessageContentReady to true itself (instead of preemptively doing it in iterator)
    if (!block.partial || this.didRejectTool) {
      // block is finished streaming and executing
      if (this.currentStreamingContentIndex === this.assistantMessageContent.length - 1) {
        // its okay that we increment if !didCompleteReadingStream, it'll just return
        // bc out of bounds and as streaming continues it will call presentAssitantMessage if a new block is ready.
        // if streaming is finished then we set userMessageContentReady to true when out of bounds.
        // This gracefully allows the stream to continue on and all potential content blocks be presented.
        // last block is complete and it is finished executing
        this.userMessageContentReady = true // will allow pwaitfor to continue
      }

      // call next block if it exists (if not then read stream will call it when its ready)
      // need to increment regardless, so when read stream calls this function again it will be streaming the next block
      this.currentStreamingContentIndex++

      if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
        // there are already more content blocks to stream, so we'll call this function ourselves
        // await this.presentAssistantContent()
        this.handleAssistantMessage()
        return
      }
    }
    // block is partial, but the read stream may have finished
    if (this.presentAssistantMessageHasPendingUpdates) {
      this.handleAssistantMessage()
    }
  }

  /**
   * Handles a block of text content, performing various transformations and checks.
   * 
   * @param block - The text content block to handle.
   * @returns A promise that resolves when the handling is complete.
   * 
   * @remarks
   * - If the tool has been rejected (`didRejectTool`), the function returns early.
   * - If the content is empty, it sends a message with the content.
   * - Removes `<thinking>` and `</thinking>` tags from the content.
   * - Checks for potential tool calls in the content and logs a warning if detected.
   * - Removes any incomplete XML tags at the end of the content.
   * - Removes end substrings of `<thinking` or `</thinking`.
   * - Removes all instances of `<thinking>` (with optional line break after) and `</thinking>` (with optional line break before).
   * - Checks if there's a '>' after the last '<' (i.e., if the tag is complete).
   * - Extracts the potential tag name.
   * - Checks if tagContent is likely an incomplete tag name (letters and underscores only).
   * - Preemptively removes `<` or `</` to keep from these artifacts showing up in chat (also handles closing thinking tags).
   * - If the tag is incomplete and at the end, removes it from the content.
   * 
   * @example
   * ```typescript
   * const textBlock: TextContent = { content: "<thinking>example</thinking>", partial: false };
   * await handleTextBlock(textBlock);
   * ```
   */
  async handleTextBlock(block: TextContent) {
    if (this.didRejectTool) {
      return
    }
    let content = block.content
    if (content) {
      content = content.replace(/<thinking>\s?/g, "")
      content = content.replace(/\s?<\/thinking>/g, "")

      const lastOpenBracketIndex = content.lastIndexOf("<")
      if (lastOpenBracketIndex !== -1) {

        const possibleTag = content.slice(lastOpenBracketIndex)
        const hasCloseBracket = possibleTag.includes(">")
        if (!hasCloseBracket) {
          let tagContent: string
          if (possibleTag.startsWith("</")) {
            tagContent = possibleTag.slice(2).trim()
          } else {
            tagContent = possibleTag.slice(1).trim()
          }

          const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
          const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
          if (isOpeningOrClosing || isLikelyTagName) {
            content = content.slice(0, lastOpenBracketIndex).trim()
          }
        }
      }
    }
    return await this.sendMessage("text", content, undefined, block.partial)
  }

  /**
   * Handles the use of a tool block.
   * 
   * @param block - The tool use block to handle.
   * 
   * This method performs the following actions:
   * - If the tool has not been rejected, it delegates the handling to the tool executor.
   * - If the tool has been rejected, it ignores any tool content after the user has rejected the tool once.
   * - If the block is not partial, it adds a message indicating that the tool is being skipped due to a previous rejection.
   * - If the block is partial, it adds a message indicating that the tool was interrupted and not executed due to a previous rejection.
   */
  async handleToolUseBlock(block: ToolUse) {
    if (!this.didRejectTool) {
      await this.toolExecutor.handleToolUse(block)
      return
    }

    if (!block.partial) {
      this.userMessageContent.push({
        type: "text",
        text: `Skipping tool ${this.getToolDescription(block)} due to user rejecting a previous tool.`,
      })
    }

    this.userMessageContent.push({
      type: "text",
      text: `Tool ${this.getToolDescription(block)} was interrupted and not executed due to user rejecting a previous tool.`,
    })
  }
}
