import * as vscode from "vscode"
import { GlobalStateKey } from "../types"

export interface ClineConfig {
  customInstructions: string
  customInstructionsMode: "system" | "user"
  alwaysAllowReadOnly: boolean
  editAutoScroll: boolean
  maxFileLineThreshold: number
  maxFileLineThresholdBehavior: "truncate" | "definitions"
  directoryContextMode: "files" | "tree"
  directoryContextMaxLines: number
  maxMistakeLimit: number
}

export class ConfigManager {
  constructor(private readonly context: vscode.ExtensionContext) { }

  async getConfig(): Promise<ClineConfig> {
    const [
      customInstructions,
      customInstructionsMode,
      alwaysAllowReadOnly,
      editAutoScroll,
      maxFileLineThreshold,
      maxFileLineThresholdBehavior,
      directoryContextMode,
      directoryContextMaxLines,
      maxMistakeLimit,
    ] = await Promise.all([
      this.getGlobalState("customInstructions") as Promise<string | undefined>,
      this.getGlobalState("customInstructionsMode") as Promise<"system" | "user" | undefined>,
      this.getGlobalState("alwaysAllowReadOnly") as Promise<boolean | undefined>,
      this.getGlobalState("editAutoScroll") as Promise<boolean | undefined>,
      this.getGlobalState("maxFileLineThreshold") as Promise<number | undefined>,
      this.getGlobalState("maxFileLineThresholdBehavior") as Promise<"truncate" | "definitions" | undefined>,
      this.getGlobalState("directoryContextMode") as Promise<"files" | "tree" | undefined>,
      this.getGlobalState("directoryContextMaxLines") as Promise<number | undefined>,
      this.getGlobalState("maxMistakeLimit") as Promise<number | undefined>,
    ])

    return {
      customInstructions: customInstructions ?? "",
      customInstructionsMode: customInstructionsMode ?? "system",
      alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
      editAutoScroll: editAutoScroll ?? false,
      maxFileLineThreshold: maxFileLineThreshold ?? 500,
      maxFileLineThresholdBehavior: maxFileLineThresholdBehavior ?? "truncate",
      directoryContextMode: directoryContextMode ?? "files",
      directoryContextMaxLines: directoryContextMaxLines ?? 200,
      maxMistakeLimit: maxMistakeLimit ?? 3,
    }
  }

  async updateConfig(key: keyof ClineConfig, value: any): Promise<void> {
    await this.updateGlobalState(key as GlobalStateKey, value)
  }

  private async updateGlobalState(key: GlobalStateKey, value: any) {
    await this.context.globalState.update(key, value)
  }

  private async getGlobalState(key: GlobalStateKey) {
    return await this.context.globalState.get(key)
  }
}
