export type APIStream = AsyncGenerator<APIStreamChunk>
export type APIStreamChunk = APIStreamTextChunk | APIStreamUsageChunk

export interface APIStreamTextChunk {
	type: "text"
	text: string
}

export interface APIStreamUsageChunk {
	type: "usage"
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	totalCost?: number // openrouter
}
