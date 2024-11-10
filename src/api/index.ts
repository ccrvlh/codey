import { Anthropic } from "@anthropic-ai/sdk"
import { APIConfiguration, ModelInfo } from "../shared/interfaces"
import { AnthropicHandler } from "./providers/anthropic"
import { AwsBedrockHandler } from "./providers/bedrock"
import { GeminiHandler } from "./providers/gemini"
import { OllamaHandler } from "./providers/ollama"
import { OpenAiHandler } from "./providers/openai"
import { OpenAiNativeHandler } from "./providers/openai-native"
import { OpenRouterHandler } from "./providers/openrouter"
import { VertexHandler } from "./providers/vertex"
import { APIStream } from "./types"

export interface APIHandler {
	createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): APIStream
	getModel(): { id: string; info: ModelInfo }
}

export function buildApiHandler(configuration: APIConfiguration): APIHandler {
	const { apiProvider, ...options } = configuration
	switch (apiProvider) {
		case "anthropic":
			return new AnthropicHandler(options)
		case "openrouter":
			return new OpenRouterHandler(options)
		case "bedrock":
			return new AwsBedrockHandler(options)
		case "vertex":
			return new VertexHandler(options)
		case "openai":
			return new OpenAiHandler(options)
		case "ollama":
			return new OllamaHandler(options)
		case "gemini":
			return new GeminiHandler(options)
		case "openai-native":
			return new OpenAiNativeHandler(options)
		default:
			return new AnthropicHandler(options)
	}
}
