import Anthropic from "@anthropic-ai/sdk";
import { UserResponse } from "../shared/types";


export type AskUserResponse = {
  response: UserResponse;
  text?: string;
  images?: string[]
}

export type AssistantMessageContent = TextContent | ToolUse

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
export type UserContent = Array<
  Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>


export interface TextContent {
  type: "text"
  content: string
  partial: boolean
}

export const toolUseNames = [
  "execute_command",
  "read_file",
  "write_to_file",
  "search_files",
  "list_files",
  "list_code_definition_names",
  "inspect_site",
  "ask_followup_question",
  "attempt_completion",
  "search_replace",
  "insert_code_block",
] as const

export const toolParamNames = [
  "command",
  "path",
  "lines",
  "content",
  "regex",
  "file_pattern",
  "recursive",
  "url",
  "question",
  "result",
  "position",
] as const


// Converts array of tool call names into a union type ("execute_command" | "read_file" | ...)
export type ToolUseName = (typeof toolUseNames)[number]

export type ToolParamName = (typeof toolParamNames)[number]

export interface ToolUse {
  type: "tool_use"
  name: ToolUseName
  // params is a partial record, allowing only some or none of the possible parameters to be used
  params: Partial<Record<ToolParamName, string>>
  partial: boolean
}

export interface ExecuteCommandToolUse extends ToolUse {
  name: "execute_command"
  // Pick<Record<ToolParamName, string>, "command"> makes "command" required, but Partial<> makes it optional
  params: Partial<Pick<Record<ToolParamName, string>, "command">>
}

export interface ReadFileToolUse extends ToolUse {
  name: "read_file"
  params: Partial<Pick<Record<ToolParamName, string>, "path">>
}

export interface WriteToFileToolUse extends ToolUse {
  name: "write_to_file"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "content">>
}

export interface SearchFilesToolUse extends ToolUse {
  name: "search_files"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "regex" | "file_pattern">>
}

export interface ListFilesToolUse extends ToolUse {
  name: "list_files"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "recursive">>
}

export interface ListCodeDefinitionNamesToolUse extends ToolUse {
  name: "list_code_definition_names"
  params: Partial<Pick<Record<ToolParamName, string>, "path">>
}

export interface InspectSiteToolUse extends ToolUse {
  name: "inspect_site"
  params: Partial<Pick<Record<ToolParamName, string>, "url">>
}

export interface AskFollowupQuestionToolUse extends ToolUse {
  name: "ask_followup_question"
  params: Partial<Pick<Record<ToolParamName, string>, "question">>
}

export interface AttemptCompletionToolUse extends ToolUse {
  name: "attempt_completion"
  params: Partial<Pick<Record<ToolParamName, string>, "result" | "command">>
}

export interface InsertCodeBlockToolUse extends ToolUse {
  name: "insert_code_block"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "position" | "content">>
}

export type SecretKey =
  | "apiKey"
  | "openRouterApiKey"
  | "awsAccessKey"
  | "awsSecretKey"
  | "awsSessionToken"
  | "openAiApiKey"
  | "geminiApiKey"
  | "openAiNativeApiKey"

export type GlobalStateKey =
  | "apiProvider"
  | "apiModelId"
  | "awsRegion"
  | "vertexProjectId"
  | "vertexRegion"
  | "lastShownAnnouncementId"
  | "customInstructions"
  | "alwaysAllowReadOnly"
  | "editAutoScroll"
  | "taskHistory"
  | "openAiBaseUrl"
  | "openAiModelId"
  | "ollamaModelId"
  | "ollamaBaseUrl"
  | "anthropicBaseUrl"
  | "azureApiVersion"
  | "openRouterModelId"
  | "openRouterModelInfo"
  | "maxFileLineThreshold"
  | "maxFileLineThresholdBehavior"
  | "directoryContextMode"
  | "directoryContextMaxLines"
  | "maxMistakeLimit"
  | "exportIncludesSystemPrompt"
