// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

export type ExtensionMessageType =
  | "action"
  | "state"
  | "selectedImages"
  | "ollamaModels"
  | "theme"
  | "workspaceUpdated"
  | "invoke"
  | "partialMessage"
  | "openRouterModels"

// webview will hold state
export interface ExtensionMessage {
  type: ExtensionMessageType
  text?: string
  action?: "chatButtonClicked" | "settingsButtonClicked" | "historyButtonClicked" | "didBecomeVisible"
  invoke?: "sendMessage" | "primaryButtonClick" | "secondaryButtonClick"
  state?: ExtensionState
  images?: string[]
  ollamaModels?: string[]
  filePaths?: string[]
  partialMessage?: ClineMessage
  openRouterModels?: Record<string, ModelInfo>
}

export interface ExtensionState {
  version: string
  apiConfiguration?: ApiConfiguration
  customInstructions?: string
  alwaysAllowReadOnly?: boolean
  editAutoScroll?: boolean
  uriScheme?: string
  clineMessages: ClineMessage[]
  taskHistory: HistoryItem[]
  shouldShowAnnouncement: boolean
}

export interface ClineMessage {
  ts: number
  type: "ask" | "say"
  ask?: ClineAsk
  say?: ClineSay
  text?: string
  images?: string[]
  partial?: boolean
}

export type ClineAsk =
  | "followup"
  | "command"
  | "command_output"
  | "completion_result"
  | "tool"
  | "api_req_failed"
  | "resume_task"
  | "resume_completed_task"
  | "mistake_limit_reached"

export type ClineSay =
  | "task"
  | "error"
  | "api_req_started"
  | "api_req_finished"
  | "text"
  | "completion_result"
  | "user_feedback"
  | "user_feedback_diff"
  | "api_req_retried"
  | "command_output"
  | "tool"
  | "shell_integration_warning"
  | "inspect_site_result"

export interface ClineSayTool {
  tool:
  | "editedExistingFile"
  | "newFileCreated"
  | "readFile"
  | "listFilesTopLevel"
  | "listFilesRecursive"
  | "listCodeDefinitionNames"
  | "searchFiles"
  | "inspectSite"
  | "searchReplace"
  | "insertCodeBlock"
  path?: string
  diff?: string
  content?: string
  regex?: string
  filePattern?: string
}

export interface ClineApiReqInfo {
  request?: string
  tokensIn?: number
  tokensOut?: number
  cacheWrites?: number
  cacheReads?: number
  cost?: number
  cancelReason?: ClineApiReqCancelReason
  streamingFailedMessage?: string
}

export type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled"

export type HistoryItem = {
  id: string
  ts: number
  task: string
  tokensIn: number
  tokensOut: number
  cacheWrites?: number
  cacheReads?: number
  totalCost: number
}

export interface WebviewMessage {
  type:
  | "apiConfiguration"
  | "customInstructions"
  | "alwaysAllowReadOnly"
  | "editAutoScroll"
  | "webviewDidLaunch"
  | "newTask"
  | "askResponse"
  | "clearTask"
  | "didShowAnnouncement"
  | "selectImages"
  | "exportCurrentTask"
  | "showTaskWithId"
  | "deleteTaskWithId"
  | "exportTaskWithId"
  | "resetState"
  | "requestOllamaModels"
  | "openImage"
  | "openFile"
  | "openMention"
  | "cancelTask"
  | "refreshOpenRouterModels"
  | "maxFileLineThreshold"
  | "maxFileLineThresholdBehavior"
  | "directoryContextMode"
  | "directoryContextMaxLines"
  | "maxMistakeLimit"
  text?: string
  askResponse?: UserResponse
  apiConfiguration?: ApiConfiguration
  images?: string[]
  bool?: boolean
  value?: number  // Added for number-based config values
}

export type UserResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ApiProvider =
  | "anthropic"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "openai"
  | "ollama"
  | "gemini"
  | "openai-native"

export interface ApiHandlerOptions {
  apiModelId?: string
  apiKey?: string // anthropic
  anthropicBaseUrl?: string
  openRouterApiKey?: string
  openRouterModelId?: string
  openRouterModelInfo?: ModelInfo
  awsAccessKey?: string
  awsSecretKey?: string
  awsSessionToken?: string
  awsRegion?: string
  vertexProjectId?: string
  vertexRegion?: string
  openAiBaseUrl?: string
  openAiApiKey?: string
  openAiModelId?: string
  ollamaModelId?: string
  ollamaBaseUrl?: string
  geminiApiKey?: string
  openAiNativeApiKey?: string
  azureApiVersion?: string
}

export type ApiConfiguration = ApiHandlerOptions & {
  apiProvider?: ApiProvider
}

// Models

export interface ModelInfo {
  maxTokens?: number
  contextWindow?: number
  supportsImages?: boolean
  supportsPromptCache: boolean // this value is hardcoded for now
  inputPrice?: number
  outputPrice?: number
  cacheWritesPrice?: number
  cacheReadsPrice?: number
  description?: string
}
