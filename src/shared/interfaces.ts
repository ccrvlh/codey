import { APIProvider, APIRequestCancelReason, CodeyAsk, CodeySay, CodeySayToolName, ExtensionMessageType, UserResponse, WebviewMessageType } from "./types"


export interface ExtensionMessage {
  type: ExtensionMessageType
  text?: string
  action?: "chatButtonClicked" | "settingsButtonClicked" | "historyButtonClicked" | "didBecomeVisible"
  invoke?: "sendMessage" | "primaryButtonClick" | "secondaryButtonClick"
  state?: ExtensionState
  images?: string[]
  ollamaModels?: string[]
  filePaths?: string[]
  partialMessage?: CodeyMessage
  openRouterModels?: Record<string, ModelInfo>
}


export interface ExtensionState {
  version: string
  apiConfiguration?: APIConfiguration
  customInstructions?: string
  alwaysAllowReadOnly?: boolean
  editAutoScroll?: boolean
  uriScheme?: string
  codeyMessages: CodeyMessage[]
  taskHistory: HistoryItem[]
  shouldShowAnnouncement: boolean
}


export interface CodeyMessage {
  ts: number
  type: "ask" | "say"
  ask?: CodeyAsk
  say?: CodeySay
  text?: string
  images?: string[]
  partial?: boolean
}


export interface CodeySayTool {
  tool: CodeySayToolName
  path?: string
  diff?: string
  content?: string
  regex?: string
  filePattern?: string
}


export interface APIRequestInfo {
  request?: string
  tokensIn?: number
  tokensOut?: number
  cacheWrites?: number
  cacheReads?: number
  cost?: number
  cancelReason?: APIRequestCancelReason
  streamingFailedMessage?: string
}


export interface HistoryItem {
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
  type: WebviewMessageType
  text?: string
  askResponse?: UserResponse
  apiConfiguration?: APIConfiguration
  images?: string[]
  bool?: boolean
  value?: number  // Added for number-based config values
}


export interface APIHandlerOptions {
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


export interface APIConfiguration extends APIHandlerOptions {
  apiProvider?: APIProvider
}


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
