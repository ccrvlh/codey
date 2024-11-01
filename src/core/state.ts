import { Anthropic } from "@anthropic-ai/sdk"
import { ClineMessage } from "../shared/ExtensionMessage"
import { AssistantMessageContent } from "../types"

/**
 * Manages conversation-related state including message history and metrics
 */
export class ConversationState {
  apiConversationHistory: Anthropic.MessageParam[] = []
  clineMessages: ClineMessage[] = []
  lastMessageTs?: number
  consecutiveMistakeCount: number = 0

  reset() {
    this.apiConversationHistory = []
    this.clineMessages = []
    this.lastMessageTs = undefined
    this.consecutiveMistakeCount = 0
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
}

/**
 * Main state management class that combines all state aspects
 */
export class ClineState {
  conversation: ConversationState
  streaming: StreamingState
  task: TaskState

  constructor() {
    this.conversation = new ConversationState()
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
   * Updates Cline messages and manages related state
   */
  addToClineMessages(message: ClineMessage) {
    this.conversation.clineMessages.push(message)
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
