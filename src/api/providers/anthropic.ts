import { Anthropic } from "@anthropic-ai/sdk"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import { APIHandlerOptions, ModelInfo } from "../../shared/interfaces"
import { ApiHandler } from "../index"
import { ApiStream } from "../transform/stream"


const DEFAULT_MODEL_ID = "claude-3-5-sonnet-20241022"

const MODELS = {
	"claude-3-5-sonnet-20241022": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens
		outputPrice: 15.0, // $15 per million output tokens
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
	},
	"claude-3-opus-20240229": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 15.0,
		outputPrice: 75.0,
		cacheWritesPrice: 18.75,
		cacheReadsPrice: 1.5,
	},
	"claude-3-haiku-20240307": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.25,
		outputPrice: 1.25,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
	},
} as const satisfies Record<string, ModelInfo>

type MODEL_ID = keyof typeof MODELS

export class AnthropicHandler implements ApiHandler {
	private options: APIHandlerOptions
	private client: Anthropic

	constructor(options: APIHandlerOptions) {
		this.options = options
		this.client = new Anthropic({
			apiKey: this.options.apiKey,
			baseURL: this.options.anthropicBaseUrl || undefined,
		})
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		let stream: AnthropicStream<Anthropic.Beta.PromptCaching.Messages.RawPromptCachingBetaMessageStreamEvent>
		const modelId = this.getModel().id
		switch (modelId) {
			// 'latest' alias does not support cache_control
			case "claude-3-5-sonnet-20241022":
			case "claude-3-opus-20240229":
			case "claude-3-haiku-20240307": {
				/*
				The latest message will be the new user message, one before will be the assistant message from a previous request, and the user message before that will be a previously cached user message. So we need to mark the latest user message as ephemeral to cache it for the next request, and mark the second to last user message as ephemeral to let the server know the last message to retrieve from the cache for the current request..
				*/
				const userMsgIndices = messages.reduce(
					(acc, msg, index) => (msg.role === "user" ? [...acc, index] : acc),
					[] as number[]
				)
				const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
				const secondLastMsgUserIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1
				stream = await this.client.beta.promptCaching.messages.create(
					{
						model: modelId,
						max_tokens: this.getModel().info.maxTokens || 8192,
						temperature: 0,
						system: [{ text: systemPrompt, type: "text", cache_control: { type: "ephemeral" } }], // setting cache breakpoint for system prompt so new tasks can reuse it
						messages: messages.map((message, index) => {
							if (index === lastUserMsgIndex || index === secondLastMsgUserIndex) {
								return {
									...message,
									content:
										typeof message.content === "string"
											? [
												{
													type: "text",
													text: message.content,
													cache_control: { type: "ephemeral" },
												},
											]
											: message.content.map((content, contentIndex) =>
												contentIndex === message.content.length - 1
													? { ...content, cache_control: { type: "ephemeral" } }
													: content
											),
								}
							}
							return message
						}),
						// tools, // cache breakpoints go from tools > system > messages, and since tools dont change, we can just set the breakpoint at the end of system (this avoids having to set a breakpoint at the end of tools which by itself does not meet min requirements for haiku caching)
						// tool_choice: { type: "auto" },
						// tools: tools,
						stream: true,
					},
					(() => {
						// prompt caching: https://x.com/alexalbert__/status/1823751995901272068
						// https://github.com/anthropics/anthropic-sdk-typescript?tab=readme-ov-file#default-headers
						// https://github.com/anthropics/anthropic-sdk-typescript/commit/c920b77fc67bd839bfeb6716ceab9d7c9bbe7393
						switch (modelId) {
							case "claude-3-5-sonnet-20241022":
								return {
									headers: {
										"anthropic-beta": "prompt-caching-2024-07-31",
									},
								}
							case "claude-3-haiku-20240307":
								return {
									headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
								}
							default:
								return undefined
						}
					})()
				)
				break
			}
			default: {
				stream = (await this.client.messages.create({
					model: modelId,
					max_tokens: this.getModel().info.maxTokens || 8192,
					temperature: 0,
					system: [{ text: systemPrompt, type: "text" }],
					messages,
					// tools,
					// tool_choice: { type: "auto" },
					stream: true,
				})) as any
				break
			}
		}

		for await (const chunk of stream) {
			switch (chunk.type) {
				case "message_start":
					// tells us cache reads/writes/input/output
					const usage = chunk.message.usage
					yield {
						type: "usage",
						inputTokens: usage.input_tokens || 0,
						outputTokens: usage.output_tokens || 0,
						cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
						cacheReadTokens: usage.cache_read_input_tokens || undefined,
					}
					break
				case "message_delta":
					// tells us stop_reason, stop_sequence, and output tokens along the way and at the end of the message

					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: chunk.usage.output_tokens || 0,
					}
					break
				case "message_stop":
					// no usage data, just an indicator that the message is done
					break
				case "content_block_start":
					switch (chunk.content_block.type) {
						case "text":
							// we may receive multiple text blocks, in which case just insert a line break between them
							if (chunk.index > 0) {
								yield {
									type: "text",
									text: "\n",
								}
							}
							yield {
								type: "text",
								text: chunk.content_block.text,
							}
							break
					}
					break
				case "content_block_delta":
					switch (chunk.delta.type) {
						case "text_delta":
							yield {
								type: "text",
								text: chunk.delta.text,
							}
							break
					}
					break
				case "content_block_stop":
					break
			}
		}
	}

	getModel(): { id: MODEL_ID; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in MODELS) {
			const id = modelId as MODEL_ID
			return { id, info: MODELS[id] }
		}
		return { id: DEFAULT_MODEL_ID, info: MODELS[DEFAULT_MODEL_ID] }
	}
}
