import { ApiConfiguration } from "./api"

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
	askResponse?: ClineAskResponse
	apiConfiguration?: ApiConfiguration
	images?: string[]
	bool?: boolean
	value?: number  // Added for number-based config values
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"
