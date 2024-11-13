export type CodeyAsk =
  | "followup"
  | "command"
  | "command_output"
  | "completion_result"
  | "tool"
  | "api_req_failed"
  | "resume_task"
  | "resume_completed_task"
  | "mistake_limit_reached"


export type CodeySay =
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


export type CodeySayToolName =
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


export type APIProvider =
  | "anthropic"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "openai"
  | "ollama"
  | "gemini"
  | "openai-native"


export type APIRequestCancelReason =
  | "streaming_failed"
  | "user_cancelled"


export type UserResponse =
  | "yesButtonClicked"
  | "noButtonClicked"
  | "messageResponse"


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


export type WebviewMessageType =
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
  | "exportTaskDebug"
  | "showTaskWithId"
  | "deleteTaskWithId"
  | "exportTaskWithId"
  | "exportDebugTaskWithId"
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
