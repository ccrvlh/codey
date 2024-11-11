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
import { APIProvider, ExtensionMessage, HistoryItem, ModelInfo, WebviewMessage } from "../shared/interfaces"
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
  private latestAnnouncementId = "oct-9-2024" // update to some unique identifier when we add a new announcement

  constructor(readonly context: vscode.ExtensionContext, private readonly outputChannel: vscode.OutputChannel) {
    this.outputChannel.appendLine("CodeyProvider instantiated")
    ViewProvider.activeInstances.add(this)
    this.workspaceTracker = new WorkspaceTracker(this)
    this.configManager = new ConfigManager(context)
  }

  /*
    VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
    - https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
    - https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
    */
  async dispose() {
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

  public static getVisibleInstance(): ViewProvider | undefined {
    return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView | vscode.WebviewPanel
    //context: vscode.WebviewViewResolveContext<unknown>, used to recreate a deallocated webview, but we don't need this since we use retainContextWhenHidden
    //token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.outputChannel.appendLine("Resolving webview view")
    this.view = webviewView

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }
    webviewView.webview.html = this.getHtmlContent(webviewView.webview)

    // Sets up an event listener to listen for messages passed from the webview view context
    // and executes code based on the message that is recieved
    this.setWebviewMessageListener(webviewView.webview)

    // Logs show up in bottom panel > Debug Console
    //console.log("registering listener")

    // Listen for when the panel becomes visible
    // https://github.com/microsoft/vscode-discussions/discussions/840
    if ("onDidChangeViewState" in webviewView) {
      // WebviewView and WebviewPanel have all the same properties except for this visibility listener
      // panel
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
      // sidebar
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

    // Listen for when the view is disposed
    // This happens when the user closes the view or when the view is closed programmatically
    webviewView.onDidDispose(
      async () => {
        await this.dispose()
      },
      null,
      this.disposables
    )

    // Listen for when color changes
    vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e && e.affectsConfiguration("workbench.colorTheme")) {
          // Sends latest theme name to webview
          await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
        }
      },
      null,
      this.disposables
    )

    this.clearTask()
    this.outputChannel.appendLine("Webview view resolved")
  }

  async initCodeyWithTask(task?: string, images?: string[]) {
    await this.clearTask()
    const { apiConfiguration } = await this.getState()
    const config = await this.configManager.getConfig()
    this.agent = new Agent(this, apiConfiguration, config, task, images, undefined)
  }

  async initCodeyWithHistoryItem(historyItem: HistoryItem) {
    await this.clearTask()
    const { apiConfiguration } = await this.getState()
    const config = await this.configManager.getConfig()
    this.agent = new Agent(
      this,
      apiConfiguration,
      config,
      undefined,
      undefined,
      historyItem,
    )
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
    // Get the local path to main script run in the webview,
    // then convert it to a uri we can use in the webview.

    // The CSS file from the React build output
    const stylesUri = getUri(webview, this.context.extensionUri, [
      "webview",
      "build",
      "static",
      "css",
      "main.css",
    ])
    // The JS file from the React build output
    const scriptUri = getUri(webview, this.context.extensionUri, ["webview", "build", "static", "js", "main.js"])

    // The codicon font from the React build output
    // https://github.com/microsoft/vscode-extension-samples/blob/main/webview-codicons-sample/src/extension.ts
    // we installed this package in the extension so that we can access it how its intended from the extension (the font file is likely bundled in vscode), and we just import the css fileinto our react app we don't have access to it
    // don't forget to add font-src ${webview.cspSource};
    const codiconsUri = getUri(webview, this.context.extensionUri, [
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ])

    // const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.js"))

    // const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "reset.css"))
    // const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "vscode.css"))

    // // Same for stylesheet
    // const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.css"))

    // Use a nonce to only allow a specific script to be run.
    /*
        content security policy of your webview to only allow scripts that have a specific nonce
        create a content security policy meta tag so that only loading scripts with a nonce is allowed
        As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicity allow for these resources. E.g.
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
    - 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
    - since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

        in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
        */
    const nonce = getNonce()

    // Tip: Install the es6-string-html VS Code extension to enable code highlighting below
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
            getTheme().then((theme) =>
              this.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) })
            )
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
              const { historyItem } = await this.getTaskWithId(this.agent.taskId)
              this.agent.abortTask()
              await pWaitFor(() => this.agent === undefined || this.agent.didFinishAborting, {
                timeout: 3_000,
              }).catch(() => {
                console.error("Failed to abort task")
              })
              if (this.agent) {
                // 'abandoned' will prevent this codey instance from affecting future codey instance gui. this may happen if its hanging on a streaming request
                this.agent.abandoned = true
              }
              await this.initCodeyWithHistoryItem(historyItem) // clears task again, so we need to abortTask manually above
              // await this.postStateToWebview() // new Codey instance will post state when it's ready. having this here sent an empty messages array to webview leading to virtuoso having to reload the entire list
            }

            break
          // Add more switch case statements here as more webview message commands
          // are created within the webview context (i.e. inside media/main.js)
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
    // await this.postMessageToWebview({ type: "action", action: "settingsButtonClicked" }) // bad ux if user is on welcome
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
      /*
      {
        "id": "anthropic/claude-3.5-sonnet",
        "name": "Anthropic: Claude 3.5 Sonnet",
        "created": 1718841600,
        "description": "Claude 3.5 Sonnet delivers better-than-Opus capabilities, faster-than-Sonnet speeds, at the same Sonnet prices. Sonnet is particularly good at:\n\n- Coding: Autonomously writes, edits, and runs code with reasoning and troubleshooting\n- Data science: Augments human data science expertise; navigates unstructured data while using multiple tools for insights\n- Visual processing: excelling at interpreting charts, graphs, and images, accurately transcribing text to derive insights beyond just the text alone\n- Agentic tasks: exceptional tool use, making it great at agentic tasks (i.e. complex, multi-step problem solving tasks that require engaging with other systems)\n\n#multimodal",
        "context_length": 200000,
        "architecture": {
          "modality": "text+image-\u003Etext",
          "tokenizer": "Claude",
          "instruct_type": null
        },
        "pricing": {
          "prompt": "0.000003",
          "completion": "0.000015",
          "image": "0.0048",
          "request": "0"
        },
        "top_provider": {
          "context_length": 200000,
          "max_completion_tokens": 8192,
          "is_moderated": true
        },
        "per_request_limits": null
      },
      */
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

  // Task history

  async getTaskWithId(id: string): Promise<{
    historyItem: HistoryItem
    taskDirPath: string
    apiConversationHistoryFilePath: string
    uiMessagesFilePath: string
    apiConversationHistory: Anthropic.MessageParam[]
  }> {
    const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
    const historyItem = history.find((item) => item.id === id)
    if (historyItem) {
      const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
      const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
      const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
      const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
      if (fileExists) {
        const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
        return {
          historyItem,
          taskDirPath,
          apiConversationHistoryFilePath,
          uiMessagesFilePath,
          apiConversationHistory,
        }
      }
    }
    // if we tried to get a task that doesn't exist, remove it from state
    // FIXME: this seems to happen sometimes when the json file doesnt save to disk for some reason
    await this.deleteTaskFromState(id)
    throw new Error("Task not found")
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
    await downloadTask(historyItem, apiConversationHistory)
  }

  async exportTaskDebug(id: string) {
    const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
    await downloadTaskDebug(historyItem, apiConversationHistory)
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

  async postStateToWebview() {
    const state = await this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "state", state })
  }

  async getStateToPostToWebview() {
    const { apiConfiguration, lastShownAnnouncementId, customInstructions, alwaysAllowReadOnly, editAutoScroll, taskHistory } =
      await this.getState()
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

  async clearTask() {
    this.agent?.abortTask()
    this.agent = undefined // removes reference to it, so once promises end it will be garbage collected
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

  // global

  async updateGlobalState(key: GlobalStateKey, value: any) {
    await this.context.globalState.update(key, value)
  }

  async getGlobalState(key: GlobalStateKey) {
    return await this.context.globalState.get(key)
  }

  // secrets

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

  // dev

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
