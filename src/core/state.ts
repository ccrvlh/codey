import { Anthropic } from "@anthropic-ai/sdk"
import fs from "fs/promises"
import path from "path"
import { combineApiRequests, combineCommandSequences } from "../shared/combiners"
import { CodeyMessage } from "../shared/interfaces"
import { getApiMetrics } from "../shared/metrics"
import { AssistantMessageContent } from "../types"
import { GlobalFileNames } from "../utils/const"
import { ensureTaskDirectoryExists } from "../utils/fs"
import { findLastIndex } from "../utils/helpers"

/**
 * Manages conversation-related state including message history and metrics
 */
export class ConversationState {
  apiConversationHistory: Anthropic.MessageParam[] = []
  codeyMessages: CodeyMessage[] = []
  lastMessageTs?: number
  consecutiveMistakeCount: number = 0
  desktopPath: string
  cwd: string
  globalStoragePath: string

  readonly taskId: string
  private providerRef: WeakRef<any>

  constructor(taskId: string, providerRef: WeakRef<any>, cwd: string, desktopPath: string, globalStoragePath: string) {
    this.taskId = taskId
    this.providerRef = providerRef
    this.cwd = cwd
    this.desktopPath = desktopPath
    this.globalStoragePath = globalStoragePath
  }

  reset() {
    this.apiConversationHistory = []
    this.codeyMessages = []
    this.lastMessageTs = undefined
    this.consecutiveMistakeCount = 0
  }

  incrementMistakeCount() {
    this.consecutiveMistakeCount++
  }

  resetMistakeCount() {
    this.consecutiveMistakeCount = 0
  }

  getMistakeCount(): number {
    return this.consecutiveMistakeCount
  }

  updateLastMessageTimestamp(ts: number) {
    this.lastMessageTs = ts
  }

  getLastMessageTimestamp(): number | undefined {
    return this.lastMessageTs
  }

  async addMessage(message: CodeyMessage) {
    this.codeyMessages.push(message)
    this.lastMessageTs = message.ts
    await this.saveCodeyMessages()
  }

  getLastMessage(): CodeyMessage | undefined {
    return this.codeyMessages.at(-1)
  }

  isLastMessagePartial(): boolean {
    const lastMessage = this.getLastMessage()
    return lastMessage ? !!lastMessage.partial : false
  }

  async updateLastMessage(updates: Partial<CodeyMessage>) {
    const lastMessage = this.getLastMessage()
    if (lastMessage) {
      Object.assign(lastMessage, updates)
      await this.saveCodeyMessages()
    }
  }

  async addApiMessage(message: Anthropic.MessageParam) {
    this.apiConversationHistory.push(message)
    await this.saveApiConversationHistory()
  }

  getApiHistory(): Anthropic.MessageParam[] {
    return this.apiConversationHistory
  }

  async truncateApiHistory(newHistory: Anthropic.MessageParam[]) {
    this.apiConversationHistory = newHistory
    await this.saveApiConversationHistory()
  }

  getTaskId(): string {
    return this.taskId
  }

  getCwd(): string {
    return this.cwd
  }

  getDesktopPath(): string {
    return this.desktopPath
  }

  async addToApiConversationHistory(message: Anthropic.MessageParam) {
    this.apiConversationHistory.push(message)
    await this.saveApiConversationHistory()
  }

  async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
    this.apiConversationHistory = newHistory
    await this.saveApiConversationHistory()
  }

  private async saveApiConversationHistory() {
    try {
      const dir = await ensureTaskDirectoryExists(this.globalStoragePath, this.taskId)
      const filePath = path.join(dir, GlobalFileNames.apiConversationHistory)
      const content = JSON.stringify(this.apiConversationHistory)
      await fs.writeFile(filePath, content)
    } catch (error) {
      console.error("Failed to save API conversation history:", error)
    }
  }

  async addToCodeyMessages(message: CodeyMessage) {
    this.codeyMessages.push(message)
    await this.saveCodeyMessages()
  }

  async overwriteCodeyMessages(newMessages: CodeyMessage[]) {
    this.codeyMessages = newMessages
    await this.saveCodeyMessages()
  }

  async saveCodeyMessages() {
    try {
      const dir = await ensureTaskDirectoryExists(this.globalStoragePath, this.taskId)
      const filePath = path.join(dir, GlobalFileNames.uiMessages)
      await fs.writeFile(filePath, JSON.stringify(this.codeyMessages))
      // combined as they are in ChatView
      const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.codeyMessages.slice(1))))
      const taskMessage = this.codeyMessages[0] // first message is always the task say
      const lastRelevantMessage =
        this.codeyMessages[
        findLastIndex(
          this.codeyMessages,
          (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
        )
        ]
      await this.providerRef.deref()?.updateTaskHistory({
        id: this.taskId,
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
}

/**
 * Manages streaming-related state during API interactions
 */
export class StreamingState {
  currentStreamingContentIndex: number = 0
  assistantMessageContent: AssistantMessageContent[] = []
  presentAssistantMessageLocked: boolean = false
  presentAssistantMessageHasPendingUpdates: boolean = false
  userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
  userMessageContentReady: boolean = false
  didCompleteReadingStream: boolean = false

  reset() {
    this.currentStreamingContentIndex = 0
    this.assistantMessageContent = []
    this.presentAssistantMessageLocked = false
    this.presentAssistantMessageHasPendingUpdates = false
    this.userMessageContent = []
    this.userMessageContentReady = false
    this.didCompleteReadingStream = false
  }

  prepareForStreaming() {
    this.reset()
  }

  isOutOfBounds(): boolean {
    return this.currentStreamingContentIndex >= this.assistantMessageContent.length
  }

  getCurrentBlock(): AssistantMessageContent | undefined {
    if (this.isOutOfBounds()) {
      return undefined
    }
    return this.assistantMessageContent[this.currentStreamingContentIndex]
  }

  addAssistantContent(content: AssistantMessageContent) {
    this.assistantMessageContent.push(content)
  }

  incrementContentIndex() {
    this.currentStreamingContentIndex++
  }

  isLastBlock(): boolean {
    return this.currentStreamingContentIndex === this.assistantMessageContent.length - 1
  }

  pushUserContent(content: Anthropic.TextBlockParam | Anthropic.ImageBlockParam) {
    this.userMessageContent.push(content)
  }

  setStreamingComplete() {
    this.didCompleteReadingStream = true
    if (this.isOutOfBounds()) {
      this.userMessageContentReady = true
    }
  }

  lockMessagePresentation() {
    this.presentAssistantMessageLocked = true
    this.presentAssistantMessageHasPendingUpdates = false
  }

  unlockMessagePresentation() {
    this.presentAssistantMessageLocked = false
  }

  markPendingUpdates() {
    this.presentAssistantMessageHasPendingUpdates = true
  }

  hasPendingUpdates(): boolean {
    return this.presentAssistantMessageHasPendingUpdates
  }
}

/**
 * Manages task execution state and flags
 */
export class TaskState {
  abort: boolean = false
  abandoned: boolean = false
  didFinishAborting: boolean = false
  didEditFile: boolean = false
  didRejectTool: boolean = false

  reset() {
    this.abort = false
    this.abandoned = false
    this.didFinishAborting = false
    this.didEditFile = false
    this.didRejectTool = false
  }

  abortTask() {
    this.abort = true
    this.didFinishAborting = true
  }

  abandonTask() {
    this.abandoned = true
  }

  markFileEdited() {
    this.didEditFile = true
  }

  markToolRejected() {
    this.didRejectTool = true
  }

  shouldContinueProcessing(): boolean {
    return !this.abort && !this.abandoned
  }

  resetFileEditState() {
    this.didEditFile = false
  }

  isAborting(): boolean {
    return this.abort
  }

  hasFinishedAborting(): boolean {
    return this.didFinishAborting
  }
}

/**
 * Main state management class that combines all state aspects
 */
export class CodeyState {
  conversation: ConversationState
  streaming: StreamingState
  task: TaskState

  constructor(taskId: string) {
    this.conversation = new ConversationState(taskId, new WeakRef(this), process.cwd(), process.cwd(), process.cwd())
    this.streaming = new StreamingState()
    this.task = new TaskState()
  }

  /**
   * Resets all state to initial values
   */
  reset() {
    this.conversation.reset()
    this.streaming.reset()
    this.task.reset()
  }

  /**
   * Updates conversation history and manages related state
   */
  addToConversationHistory(message: Anthropic.MessageParam) {
    this.conversation.apiConversationHistory.push(message)
  }

  /**
   * Updates Codey messages and manages related state
   */
  addToCodeyMessages(message: CodeyMessage) {
    this.conversation.codeyMessages.push(message)
    this.conversation.lastMessageTs = message.ts
  }

  /**
   * Prepares streaming state for a new API request
   */
  prepareForStreaming() {
    this.streaming.reset()
  }

  /**
   * Updates task state for abortion
   */
  abortTask() {
    this.task.abort = true
    this.task.didFinishAborting = true
  }

  /**
   * Checks if the task should continue processing
   */
  shouldContinueProcessing(): boolean {
    return !this.task.abort && !this.task.abandoned
  }
}
