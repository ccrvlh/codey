import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import fs from "fs/promises"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { buildApiHandler } from "../api"
import { downloadTask, downloadTaskDebug } from "../integrations/misc/export"
import { openFile, openImage } from "../integrations/misc/open-file"
import { selectImages } from "../integrations/misc/process-images"
import { getTheme } from "../integrations/theme/getTheme"
import WorkspaceTracker from "../integrations/workspace/WorkspaceTracker"
import { ExtensionMessage, HistoryItem, ModelInfo, WebviewMessage } from "../shared/interfaces"
import { APIProvider } from "../shared/types"
import { GlobalStateKey, SecretKey } from "../types"
import { GlobalFileNames } from "../utils/const"
import { fileExistsAtPath } from "../utils/fs"
import { findLast, getNonce, getUri } from "../utils/helpers"
import { ConfigManager } from "./config"
import { Agent } from "./main"
import { openMention } from "./mentions"

export class ViewProvider implements vscode.WebviewViewProvider {
  private static activeInstances: Set<ViewProvider> = new Set()
  private disposables: vscode.Disposable[] = []
  private view?: vscode.WebviewView | vscode.WebviewPanel
  private agent?: Agent
  private configManager: ConfigManager
  private workspaceTracker?: WorkspaceTracker
  private latestAnnouncementId = "oct-9-2024"

  constructor(readonly context: vscode.ExtensionContext, private readonly outputChannel: vscode.OutputChannel) {
    this.outputChannel.appendLine("CodeyProvider instantiated")
    ViewProvider.activeInstances.add(this)
    this.workspaceTracker = new WorkspaceTracker(this)
    this.configManager = new ConfigManager(context)
  }

  // Builders

  /**
   * Initializes the Codey agent with a specified task and optional images.
   *
   * @param {string} [task] - The task to initialize the agent with.
   * @param {string[]} [images] - An optional array of image URLs to be used by the agent.
   * @returns {Promise<void>} A promise that resolves when the initialization is complete.
   */
  async initCodeyWithTask(task?: string, images?: string[]): Promise<void> {
    await this.clearTask()
    const { apiConfiguration } = await this.getState()
    const config = await this.configManager.getConfig()
    this.agent = new Agent(this, apiConfiguration, config, task, images, undefined)
  }

  /**
   * Initializes the Codey agent with a given history item.
   *
   * This method clears any existing tasks, retrieves the current state and configuration,
   * and then creates a new instance of the `Agent` class using the provided history item.
   *
   * @param historyItem - The history item to initialize the Codey agent with.
   * @returns A promise that resolves when the initialization is complete.
   */
  async initCodeyWithHistoryItem(historyItem: HistoryItem) {
    await this.clearTask()
    const { apiConfiguration } = await this.getState()
    const config = await this.configManager.getConfig()
    this.agent = new Agent(this, apiConfiguration, config, undefined, undefined, historyItem)
  }

  /**
   * Retrieves the last visible instance of `ViewProvider` from the active instances.
   *
   * @returns {ViewProvider | undefined} The last visible `ViewProvider` instance, or `undefined` if no visible instance is found.
   */
  public static getVisibleInstance(): ViewProvider | undefined {
    return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
  }

  /**
   * Resolves the webview view or panel and sets up necessary configurations and listeners.
   * This method sets the webview options to allow scripts and define local resource roots.
   * It sets the HTML content of the webview and sets up an event listener to handle messages from the webview.
   * Additionally, it registers listeners for visibility changes and disposal of the webview,
   * as well as a listener for configuration changes, specifically for theme changes.
   * Finally, it clears any existing tasks and logs the start and end of the resolution process to the output channel.
   *
   * context: vscode.WebviewViewResolveContext<unknown>, used to recreate a deallocated webview, but we don't need this since we use retainContextWhenHidden
   * token: vscode.CancellationToken
   *
   * https://github.com/microsoft/vscode-discussions/discussions/840
   *
   * @param webviewView - The webview view or panel to be resolved.
   *
   */
  resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel): void | Thenable<void> {
    this.outputChannel.appendLine("Resolving webview view")
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }

    webviewView.webview.html = this.getHtmlContent(webviewView.webview)
    this.setWebviewMessageListener(webviewView.webview)

    if ("onDidChangeViewState" in webviewView) {
      webviewView.onDidChangeViewState(
        () => {
          if (this.view?.visible) {
            this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
          }
        },
        null,
        this.disposables
      )
    } else if ("onDidChangeVisibility" in webviewView) {
      webviewView.onDidChangeVisibility(
        () => {
          if (this.view?.visible) {
            this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
          }
        },
        null,
        this.disposables
      )
    }

    webviewView.onDidDispose(
      async () => {
        await this.dispose()
      },
      null,
      this.disposables
    )

    vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e && e.affectsConfiguration("workbench.colorTheme")) {
          await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
        }
      },
      null,
      this.disposables
    )

    this.clearTask()
    this.outputChannel.appendLine("Webview view resolved")
  }

  async postMessageToWebview(message: ExtensionMessage) {
    // Send any JSON serializable data to the react app
    await this.view?.webview.postMessage(message)
  }

  async updateCustomInstructions(instructions?: string) {
    await this.updateGlobalState("customInstructions", instructions || "")
    const config = await this.configManager.getConfig()
    config.customInstructions = instructions || ""
    await this.postStateToWebview()
  }

  /**
   * Defines and returns the HTML that should be rendered within the webview panel.
   * Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
   * The codicon font from the React build output
   * https://github.com/microsoft/vscode-extension-samples/blob/main/webview-codicons-sample/src/extension.ts
   * we installed this package in the extension so that we can access it how its intended from the extension (the font file is likely bundled in vscode)
   * and we just import the css fileinto our react app we don't have access to it don't forget to add font-src ${webview.cspSource};
   *
   * @remarks This is also the place where references to the React webview build files
   * are created and inserted into the webview HTML.
   *
   * @param webview A reference to the extension webview
   * @param extensionUri The URI of the directory containing the extension
   * @returns A template string literal containing the HTML that should be
   * rendered within the webview panel
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const stylesUri = getUri(webview, this.context.extensionUri, ["webview", "build", "static", "css", "main.css"])
    const scriptUri = getUri(webview, this.context.extensionUri, ["webview", "build", "static", "js", "main.js"])
    const codiconsUri = getUri(webview, this.context.extensionUri, [
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ])
    const nonce = getNonce()

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
          <meta name="theme-color" content="#000000">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <link href="${codiconsUri}" rel="stylesheet" />
          <title>Codey</title>
        </head>
        <body>
          <noscript>You need to enable JavaScript to run this app.</noscript>
          <div id="root"></div>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `
  }

  /**
   * Sets up an event listener to listen for messages passed from the webview context and
   * executes code based on the message that is recieved.
   *
   * @param webview A reference to the extension webview
   */
  private setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        switch (message.type) {
          case "webviewDidLaunch":
            this.postStateToWebview()
            this.workspaceTracker?.initializeFilePaths() // don't await
            getTheme().then((theme) => this.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }))
            this.readOpenRouterModels().then((openRouterModels) => {
              if (openRouterModels) {
                this.postMessageToWebview({ type: "openRouterModels", openRouterModels })
              } else {
                // nothing cached, fetch first time
                this.refreshOpenRouterModels()
              }
            })
            break
          case "newTask":
            // Code that should run in response to the hello message command
            //vscode.window.showInformationMessage(message.text!)

            // Send a message to our webview.
            // You can send any JSON serializable data.
            // Could also do this in extension .ts
            //this.postMessageToWebview({ type: "text", text: `Extension: ${Date.now()}` })
            // initializing new instance of Codey will make sure that any agentically running promises in old instance don't affect our new task. this essentially creates a fresh slate for the new task
            await this.initCodeyWithTask(message.text, message.images)
            break
          case "apiConfiguration":
            if (message.apiConfiguration) {
              const {
                apiProvider,
                apiModelId,
                apiKey,
                openRouterApiKey,
                awsAccessKey,
                awsSecretKey,
                awsSessionToken,
                awsRegion,
                vertexProjectId,
                vertexRegion,
                openAiBaseUrl,
                openAiApiKey,
                openAiModelId,
                ollamaModelId,
                ollamaBaseUrl,
                anthropicBaseUrl,
                geminiApiKey,
                openAiNativeApiKey,
                azureApiVersion,
                openRouterModelId,
                openRouterModelInfo,
              } = message.apiConfiguration
              await this.updateGlobalState("apiProvider", apiProvider)
              await this.updateGlobalState("apiModelId", apiModelId)
              await this.storeSecret("apiKey", apiKey)
              await this.storeSecret("openRouterApiKey", openRouterApiKey)
              await this.storeSecret("awsAccessKey", awsAccessKey)
              await this.storeSecret("awsSecretKey", awsSecretKey)
              await this.storeSecret("awsSessionToken", awsSessionToken)
              await this.updateGlobalState("awsRegion", awsRegion)
              await this.updateGlobalState("vertexProjectId", vertexProjectId)
              await this.updateGlobalState("vertexRegion", vertexRegion)
              await this.updateGlobalState("openAiBaseUrl", openAiBaseUrl)
              await this.storeSecret("openAiApiKey", openAiApiKey)
              await this.updateGlobalState("openAiModelId", openAiModelId)
              await this.updateGlobalState("ollamaModelId", ollamaModelId)
              await this.updateGlobalState("ollamaBaseUrl", ollamaBaseUrl)
              await this.updateGlobalState("anthropicBaseUrl", anthropicBaseUrl)
              await this.storeSecret("geminiApiKey", geminiApiKey)
              await this.storeSecret("openAiNativeApiKey", openAiNativeApiKey)
              await this.updateGlobalState("azureApiVersion", azureApiVersion)
              await this.updateGlobalState("openRouterModelId", openRouterModelId)
              await this.updateGlobalState("openRouterModelInfo", openRouterModelInfo)
              if (this.agent) {
                this.agent.api = buildApiHandler(message.apiConfiguration)
              }
            }
            await this.postStateToWebview()
            break
          case "customInstructions":
            await this.updateCustomInstructions(message.text)
            break
          case "alwaysAllowReadOnly":
            await this.updateGlobalState("alwaysAllowReadOnly", message.bool ?? undefined)
            if (this.agent) {
              this.agent.config.alwaysAllowReadOnly = message.bool ?? false
            }
            await this.postStateToWebview()
            break
          case "exportIncludesSystemPrompt":
            await this.updateGlobalState("exportIncludesSystemPrompt", message.bool ?? undefined)
            console.log("exportIncludesSystemPrompt", message.bool)
            if (this.agent) {
              this.agent.config.exportIncludesSystemPrompt = message.bool ?? false
            }
            await this.postStateToWebview()
            break
          case "editAutoScroll":
            await this.updateGlobalState("editAutoScroll", message.bool ?? undefined)
            if (this.agent) {
              this.agent.config.editAutoScroll = message.bool ?? false
            }
            await this.postStateToWebview()
            break
          case "askResponse":
            this.agent?.handleWebviewUserResponse(message.askResponse!, message.text, message.images)
            break
          case "clearTask":
            // newTask will start a new task with a given task text, while clear task resets the current session and allows for a new task to be started
            await this.clearTask()
            await this.postStateToWebview()
            break
          case "didShowAnnouncement":
            await this.updateGlobalState("lastShownAnnouncementId", this.latestAnnouncementId)
            await this.postStateToWebview()
            break
          case "selectImages":
            const images = await selectImages()
            await this.postMessageToWebview({ type: "selectedImages", images })
            break
          case "exportCurrentTask":
            const currentTaskId = this.agent?.taskId
            if (currentTaskId) {
              this.exportTaskWithId(currentTaskId)
            }
            break
          case "exportTaskDebug":
            if (this.agent?.taskId) {
              this.exportTaskDebug(this.agent?.taskId)
            }
            break
          case "showTaskWithId":
            this.showTaskWithId(message.text!)
            break
          case "deleteTaskWithId":
            this.deleteTaskWithId(message.text!)
            break
          case "exportTaskWithId":
            this.exportTaskWithId(message.text!)
            break
          case "exportDebugTaskWithId":
            this.exportTaskDebug(message.text!)
            break
          case "resetState":
            await this.resetState()
            break
          case "requestOllamaModels":
            const ollamaModels = await this.getOllamaModels(message.text)
            this.postMessageToWebview({ type: "ollamaModels", ollamaModels })
            break
          case "refreshOpenRouterModels":
            await this.refreshOpenRouterModels()
            break
          case "openImage":
            openImage(message.text!)
            break
          case "openFile":
            openFile(message.text!)
            break
          case "openMention":
            openMention(message.text)
            break
          case "cancelTask":
            if (this.agent) {
              // 'abandoned' will prevent this codey instance from affecting future codey instance gui.
              // this may happen if its hanging on a streaming request
              // clears task again, so we need to abortTask manually above
              // new Codey instance will post state when it's ready. having this here sent an empty messages
              // array to webview leading to virtuoso having to reload the entire list
              // await this.postStateToWebview()
              const { historyItem } = await this.getTaskWithId(this.agent.taskId)
              this.agent.abortTask()
              await pWaitFor(() => this.agent === undefined || this.agent.didFinishAborting, {
                timeout: 3_000,
              }).catch(() => {
                console.error("Failed to abort task")
              })
              if (this.agent) {
                this.agent.abandoned = true
              }
              await this.initCodeyWithHistoryItem(historyItem)
            }
            break
        }
      },
      null,
      this.disposables
    )
  }

  // LLM Interfaces

  async getOllamaModels(baseUrl?: string) {
    try {
      if (!baseUrl) {
        baseUrl = "http://localhost:11434"
      }
      if (!URL.canParse(baseUrl)) {
        return []
      }
      const response = await axios.get(`${baseUrl}/api/tags`)
      const modelsArray = response.data?.models?.map((model: any) => model.name) || []
      const models = [...new Set<string>(modelsArray)]
      return models
    } catch (error) {
      return []
    }
  }

  async handleOpenRouterCallback(code: string) {
    let apiKey: string
    try {
      const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code })
      if (response.data && response.data.key) {
        apiKey = response.data.key
      } else {
        throw new Error("Invalid response from OpenRouter API")
      }
    } catch (error) {
      console.error("Error exchanging code for API key:", error)
      throw error
    }

    const openrouter: APIProvider = "openrouter"
    await this.updateGlobalState("apiProvider", openrouter)
    await this.storeSecret("openRouterApiKey", apiKey)
    await this.postStateToWebview()
    if (this.agent) {
      this.agent.api = buildApiHandler({ apiProvider: openrouter, openRouterApiKey: apiKey })
    }
  }

  async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
    const openRouterModelsFilePath = path.join(
      await this.ensureCacheDirectoryExists(),
      GlobalFileNames.openRouterModels
    )
    const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
    if (fileExists) {
      const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
      return JSON.parse(fileContents)
    }
    return undefined
  }

  async refreshOpenRouterModels() {
    const openRouterModelsFilePath = path.join(
      await this.ensureCacheDirectoryExists(),
      GlobalFileNames.openRouterModels
    )

    let models: Record<string, ModelInfo> = {}
    try {
      const response = await axios.get("https://openrouter.ai/api/v1/models")
      if (response.data?.data) {
        const rawModels = response.data.data
        const parsePrice = (price: any) => {
          if (price) {
            return parseFloat(price) * 1_000_000
          }
          return undefined
        }
        for (const rawModel of rawModels) {
          const modelInfo: ModelInfo = {
            maxTokens: rawModel.top_provider?.max_completion_tokens,
            contextWindow: rawModel.context_length,
            supportsImages: rawModel.architecture?.modality?.includes("image"),
            supportsPromptCache: false,
            inputPrice: parsePrice(rawModel.pricing?.prompt),
            outputPrice: parsePrice(rawModel.pricing?.completion),
            description: rawModel.description,
          }

          switch (rawModel.id) {
            case "anthropic/claude-3.5-sonnet":
            case "anthropic/claude-3.5-sonnet:beta":
            case "anthropic/claude-3.5-sonnet-20240620":
            case "anthropic/claude-3.5-sonnet-20240620:beta":
              modelInfo.supportsPromptCache = true
              modelInfo.cacheWritesPrice = 3.75
              modelInfo.cacheReadsPrice = 0.3
              break
            case "anthropic/claude-3-opus":
            case "anthropic/claude-3-opus:beta":
              modelInfo.supportsPromptCache = true
              modelInfo.cacheWritesPrice = 18.75
              modelInfo.cacheReadsPrice = 1.5
              break
            case "anthropic/claude-3-haiku":
            case "anthropic/claude-3-haiku:beta":
              modelInfo.supportsPromptCache = true
              modelInfo.cacheWritesPrice = 0.3
              modelInfo.cacheReadsPrice = 0.03
              break
          }

          models[rawModel.id] = modelInfo
        }
      } else {
        console.error("Invalid response from OpenRouter API")
      }
      await fs.writeFile(openRouterModelsFilePath, JSON.stringify(models))
      console.log("OpenRouter models fetched and saved", models)
    } catch (error) {
      console.error("Error fetching OpenRouter models:", error)
    }

    await this.postMessageToWebview({ type: "openRouterModels", openRouterModels: models })
  }

  private async ensureCacheDirectoryExists(): Promise<string> {
    const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
    await fs.mkdir(cacheDir, { recursive: true })
    return cacheDir
  }

  // Task Management

  async getTaskWithId(id: string): Promise<{
    historyItem: HistoryItem
    taskDirPath: string
    apiConversationHistoryFilePath: string
    uiMessagesFilePath: string
    apiConversationHistory: Anthropic.MessageParam[]
  }> {
    const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
    const historyItem = history.find((item) => item.id === id)
    if (!historyItem) {
      await this.deleteTaskFromState(id)
      console.error("[ERROR] Task not found.")
      throw new Error("Task not found")
    }

    const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
    const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
    const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
    const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
    if (!fileExists) {
      await this.deleteTaskFromState(id)
      console.error("[ERROR] Task file not found")
      throw new Error("Task file not found")
    }

    const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
    return {
      historyItem,
      taskDirPath,
      apiConversationHistoryFilePath,
      uiMessagesFilePath,
      apiConversationHistory,
    }
  }

  async showTaskWithId(id: string) {
    if (id !== this.agent?.taskId) {
      // non-current task
      const { historyItem } = await this.getTaskWithId(id)
      await this.initCodeyWithHistoryItem(historyItem) // clears existing task
    }
    await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
  }

  async exportTaskWithId(id: string) {
    const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
    await downloadTask(historyItem, apiConversationHistory, this.agent?.config.exportIncludesSystemPrompt)
  }

  async exportTaskDebug(id: string) {
    const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
    await downloadTaskDebug(historyItem, apiConversationHistory, this.agent?.config.exportIncludesSystemPrompt)
  }

  async deleteTaskWithId(id: string) {
    if (id === this.agent?.taskId) {
      await this.clearTask()
    }

    const { taskDirPath, apiConversationHistoryFilePath, uiMessagesFilePath } = await this.getTaskWithId(id)

    await this.deleteTaskFromState(id)

    // Delete the task files
    const apiConversationHistoryFileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
    if (apiConversationHistoryFileExists) {
      await fs.unlink(apiConversationHistoryFilePath)
    }
    const uiMessagesFileExists = await fileExistsAtPath(uiMessagesFilePath)
    if (uiMessagesFileExists) {
      await fs.unlink(uiMessagesFilePath)
    }
    const legacyMessagesFilePath = path.join(taskDirPath, "claude_messages.json")
    if (await fileExistsAtPath(legacyMessagesFilePath)) {
      await fs.unlink(legacyMessagesFilePath)
    }
    await fs.rmdir(taskDirPath) // succeeds if the dir is empty
  }

  async deleteTaskFromState(id: string) {
    // Remove the task from history
    const taskHistory = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
    const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
    await this.updateGlobalState("taskHistory", updatedTaskHistory)

    // Notify the webview that the task has been deleted
    await this.postStateToWebview()
  }

  async clearTask() {
    this.agent?.abortTask()
    this.agent = undefined // removes reference to it, so once promises end it will be garbage collected
  }

  async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
    const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[]) || []
    const existingItemIndex = history.findIndex((h) => h.id === item.id)
    if (existingItemIndex !== -1) {
      history[existingItemIndex] = item
    } else {
      history.push(item)
    }
    await this.updateGlobalState("taskHistory", history)
    return history
  }

  // State Management

  async postStateToWebview() {
    const state = await this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "state", state })
  }

  async getStateToPostToWebview() {
    const {
      apiConfiguration,
      lastShownAnnouncementId,
      customInstructions,
      alwaysAllowReadOnly,
      editAutoScroll,
      taskHistory,
    } = await this.getState()
    return {
      version: this.context.extension?.packageJSON?.version ?? "",
      apiConfiguration,
      customInstructions,
      alwaysAllowReadOnly,
      editAutoScroll,
      uriScheme: vscode.env.uriScheme,
      codeyMessages: this.agent?.codeyMessages || [],
      taskHistory: (taskHistory || []).filter((item) => item.ts && item.task).sort((a, b) => b.ts - a.ts),
      shouldShowAnnouncement: lastShownAnnouncementId !== this.latestAnnouncementId,
    }
  }

  async getState() {
    const [
      storedApiProvider,
      apiModelId,
      apiKey,
      openRouterApiKey,
      awsAccessKey,
      awsSecretKey,
      awsSessionToken,
      awsRegion,
      vertexProjectId,
      vertexRegion,
      openAiBaseUrl,
      openAiApiKey,
      openAiModelId,
      ollamaModelId,
      ollamaBaseUrl,
      anthropicBaseUrl,
      geminiApiKey,
      openAiNativeApiKey,
      azureApiVersion,
      openRouterModelId,
      openRouterModelInfo,
      lastShownAnnouncementId,
      customInstructions,
      alwaysAllowReadOnly,
      editAutoScroll,
      taskHistory,
    ] = await Promise.all([
      this.getGlobalState("apiProvider") as Promise<APIProvider | undefined>,
      this.getGlobalState("apiModelId") as Promise<string | undefined>,
      this.getSecret("apiKey") as Promise<string | undefined>,
      this.getSecret("openRouterApiKey") as Promise<string | undefined>,
      this.getSecret("awsAccessKey") as Promise<string | undefined>,
      this.getSecret("awsSecretKey") as Promise<string | undefined>,
      this.getSecret("awsSessionToken") as Promise<string | undefined>,
      this.getGlobalState("awsRegion") as Promise<string | undefined>,
      this.getGlobalState("vertexProjectId") as Promise<string | undefined>,
      this.getGlobalState("vertexRegion") as Promise<string | undefined>,
      this.getGlobalState("openAiBaseUrl") as Promise<string | undefined>,
      this.getSecret("openAiApiKey") as Promise<string | undefined>,
      this.getGlobalState("openAiModelId") as Promise<string | undefined>,
      this.getGlobalState("ollamaModelId") as Promise<string | undefined>,
      this.getGlobalState("ollamaBaseUrl") as Promise<string | undefined>,
      this.getGlobalState("anthropicBaseUrl") as Promise<string | undefined>,
      this.getSecret("geminiApiKey") as Promise<string | undefined>,
      this.getSecret("openAiNativeApiKey") as Promise<string | undefined>,
      this.getGlobalState("azureApiVersion") as Promise<string | undefined>,
      this.getGlobalState("openRouterModelId") as Promise<string | undefined>,
      this.getGlobalState("openRouterModelInfo") as Promise<ModelInfo | undefined>,
      this.getGlobalState("lastShownAnnouncementId") as Promise<string | undefined>,
      this.getGlobalState("customInstructions") as Promise<string | undefined>,
      this.getGlobalState("alwaysAllowReadOnly") as Promise<boolean | undefined>,
      this.getGlobalState("editAutoScroll") as Promise<boolean | undefined>,
      this.getGlobalState("taskHistory") as Promise<HistoryItem[] | undefined>,
    ])

    let apiProvider: APIProvider
    if (storedApiProvider) {
      apiProvider = storedApiProvider
    } else {
      // Either new user or legacy user that doesn't have the apiProvider stored in state
      // (If they're using OpenRouter or Bedrock, then apiProvider state will exist)
      if (apiKey) {
        apiProvider = "anthropic"
      } else {
        // New users should default to openrouter
        apiProvider = "openrouter"
      }
    }

    return {
      apiConfiguration: {
        apiProvider,
        apiModelId,
        apiKey,
        openRouterApiKey,
        awsAccessKey,
        awsSecretKey,
        awsSessionToken,
        awsRegion,
        vertexProjectId,
        vertexRegion,
        openAiBaseUrl,
        openAiApiKey,
        openAiModelId,
        ollamaModelId,
        ollamaBaseUrl,
        anthropicBaseUrl,
        geminiApiKey,
        openAiNativeApiKey,
        azureApiVersion,
        openRouterModelId,
        openRouterModelInfo,
      },
      lastShownAnnouncementId,
      customInstructions,
      alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
      editAutoScroll: editAutoScroll ?? true,
      taskHistory,
    }
  }

  async updateGlobalState(key: GlobalStateKey, value: any) {
    await this.context.globalState.update(key, value)
  }

  async getGlobalState(key: GlobalStateKey) {
    return await this.context.globalState.get(key)
  }

  // Secrets

  private async storeSecret(key: SecretKey, value?: string) {
    if (value) {
      await this.context.secrets.store(key, value)
    } else {
      await this.context.secrets.delete(key)
    }
  }

  private async getSecret(key: SecretKey) {
    return await this.context.secrets.get(key)
  }

  /**
   * Disposes of the CodeyProvider instance, releasing all resources and cleaning up.
   * VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system.
   * This applies to event listening, commands, interacting with the UI, etc.
   * The disposal process cleans tasks, and disposes the webview, workspace tracker, and all other registered disposables.
   *
   * https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
   * https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
   *
   * @returns {Promise<void>} A promise that resolves when the disposal process is complete.
   */
  async dispose(): Promise<void> {
    this.outputChannel.appendLine("Disposing CodeyProvider...")
    await this.clearTask()
    this.outputChannel.appendLine("Cleared task")
    if (this.view && "dispose" in this.view) {
      this.view.dispose()
      this.outputChannel.appendLine("Disposed webview")
    }
    while (this.disposables.length) {
      const x = this.disposables.pop()
      if (x) {
        x.dispose()
      }
    }
    this.workspaceTracker?.dispose()
    this.workspaceTracker = undefined
    this.outputChannel.appendLine("Disposed all disposables")
    ViewProvider.activeInstances.delete(this)
  }

  async resetState() {
    vscode.window.showInformationMessage("Resetting state...")
    for (const key of this.context.globalState.keys()) {
      await this.context.globalState.update(key, undefined)
    }
    const secretKeys: SecretKey[] = [
      "apiKey",
      "openRouterApiKey",
      "awsAccessKey",
      "awsSecretKey",
      "awsSessionToken",
      "openAiApiKey",
      "geminiApiKey",
      "openAiNativeApiKey",
    ]
    for (const key of secretKeys) {
      await this.storeSecret(key, undefined)
    }
    if (this.agent) {
      this.agent.abortTask()
      this.agent = undefined
    }
    vscode.window.showInformationMessage("State reset")
    await this.postStateToWebview()
    await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
  }
}
