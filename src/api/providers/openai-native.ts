import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { APIHandler } from "../"
import { APIHandlerOptions, ModelInfo } from "../../shared/interfaces"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { APIStream } from "../types"

// OpenAI Native
// https://openai.com/api/pricing/
type OpenAiNativeModelId = keyof typeof MODELS
const DEFAULT_MODEL_ID: OpenAiNativeModelId = "gpt-4o"
const MODELS = {
	"o1-preview": {
		maxTokens: 32_768,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 15,
		outputPrice: 60,
	},
	"o1-mini": {
		maxTokens: 65_536,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 3,
		outputPrice: 12,
	},
	"gpt-4o": {
		maxTokens: 4_096,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 5,
		outputPrice: 15,
	},
	"gpt-4o-mini": {
		maxTokens: 16_384,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
	},
} as const satisfies Record<string, ModelInfo>


export class OpenAiNativeHandler implements APIHandler {
	private options: APIHandlerOptions
	private client: OpenAI

	constructor(options: APIHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			apiKey: this.options.openAiNativeApiKey,
		})
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): APIStream {
		switch (this.getModel().id) {
			case "o1-preview":
			case "o1-mini": {
				// o1 doesnt support streaming, non-1 temp, or system prompt
				const response = await this.client.chat.completions.create({
					model: this.getModel().id,
					messages: [{ role: "user", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
				})
				yield {
					type: "text",
					text: response.choices[0]?.message.content || "",
				}
				yield {
					type: "usage",
					inputTokens: response.usage?.prompt_tokens || 0,
					outputTokens: response.usage?.completion_tokens || 0,
				}
				break
			}
			default: {
				const stream = await this.client.chat.completions.create({
					model: this.getModel().id,
					// max_completion_tokens: this.getModel().info.maxTokens,
					temperature: 0,
					messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
					stream: true,
					stream_options: { include_usage: true },
				})

				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta
					if (delta?.content) {
						yield {
							type: "text",
							text: delta.content,
						}
					}

					// contains a null value except for the last chunk which contains the token usage statistics for the entire request
					if (chunk.usage) {
						yield {
							type: "usage",
							inputTokens: chunk.usage.prompt_tokens || 0,
							outputTokens: chunk.usage.completion_tokens || 0,
						}
					}
				}
			}
		}
	}

	getModel(): { id: OpenAiNativeModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in MODELS) {
			const id = modelId as OpenAiNativeModelId
			return { id, info: MODELS[id] }
		}
		return { id: DEFAULT_MODEL_ID, info: MODELS[DEFAULT_MODEL_ID] }
	}
}
