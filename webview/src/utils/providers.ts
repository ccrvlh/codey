import {
  ModelInfo,
  anthropicDefaultModelId,
  anthropicModels,
  bedrockDefaultModelId,
  bedrockModels,
  geminiDefaultModelId,
  geminiModels,
  openAiModelInfoSaneDefaults,
  openAiNativeDefaultModelId,
  openAiNativeModels,
  openRouterDefaultModelId,
  openRouterDefaultModelInfo,
  vertexDefaultModelId,
  vertexModels
} from "../../../src/shared/api"
import { APIConfiguration } from "../../../src/shared/interfaces"


export function normalizeApiConfiguration(apiConfiguration?: APIConfiguration) {
  const provider = apiConfiguration?.apiProvider || "anthropic"
  const modelId = apiConfiguration?.apiModelId

  const getProviderData = (models: Record<string, ModelInfo>, defaultId: string) => {
    let selectedModelId: string
    let selectedModelInfo: ModelInfo
    if (modelId && modelId in models) {
      selectedModelId = modelId
      selectedModelInfo = models[modelId]
    } else {
      selectedModelId = defaultId
      selectedModelInfo = models[defaultId]
    }
    return { selectedProvider: provider, selectedModelId, selectedModelInfo }
  }
  switch (provider) {
    case "anthropic":
      return getProviderData(anthropicModels, anthropicDefaultModelId)
    case "bedrock":
      return getProviderData(bedrockModels, bedrockDefaultModelId)
    case "vertex":
      return getProviderData(vertexModels, vertexDefaultModelId)
    case "gemini":
      return getProviderData(geminiModels, geminiDefaultModelId)
    case "openai-native":
      return getProviderData(openAiNativeModels, openAiNativeDefaultModelId)
    case "openrouter":
      return {
        selectedProvider: provider,
        selectedModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
        selectedModelInfo: apiConfiguration?.openRouterModelInfo || openRouterDefaultModelInfo,
      }
    case "openai":
      return {
        selectedProvider: provider,
        selectedModelId: apiConfiguration?.openAiModelId || "",
        selectedModelInfo: openAiModelInfoSaneDefaults,
      }
    case "ollama":
      return {
        selectedProvider: provider,
        selectedModelId: apiConfiguration?.ollamaModelId || "",
        selectedModelInfo: openAiModelInfoSaneDefaults,
      }
    default:
      return getProviderData(anthropicModels, anthropicDefaultModelId)
  }
}

export function formatPrice(price: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price)
}
