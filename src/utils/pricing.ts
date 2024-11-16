import { ModelInfo } from "../shared/interfaces"

/**
 * Calculates the cost of using an API based on the provided model information and token counts.
 *
 * @param modelInfo - An object containing pricing information for the model.
 * @param inputTokens - The number of input tokens used.
 * @param outputTokens - The number of output tokens generated.
 * @param cacheCreationInputTokens - (Optional) The number of input tokens used for cache creation.
 * @param cacheReadInputTokens - (Optional) The number of input tokens used for cache reads.
 * @returns The total cost calculated based on the provided parameters.
 */
export function calculateApiCost(
  modelInfo: ModelInfo,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number
): number {
  const modelCacheWritesPrice = modelInfo.cacheWritesPrice
  let cacheWritesCost = 0
  if (cacheCreationInputTokens && modelCacheWritesPrice) {
    cacheWritesCost = (modelCacheWritesPrice / 1_000_000) * cacheCreationInputTokens
  }
  const modelCacheReadsPrice = modelInfo.cacheReadsPrice
  let cacheReadsCost = 0
  if (cacheReadInputTokens && modelCacheReadsPrice) {
    cacheReadsCost = (modelCacheReadsPrice / 1_000_000) * cacheReadInputTokens
  }
  const baseInputCost = ((modelInfo.inputPrice || 0) / 1_000_000) * inputTokens
  const outputCost = ((modelInfo.outputPrice || 0) / 1_000_000) * outputTokens
  const totalCost = cacheWritesCost + cacheReadsCost + baseInputCost + outputCost
  return totalCost
}
