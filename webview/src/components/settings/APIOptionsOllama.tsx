import { VSCodeLink, VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { APIConfiguration } from "../../../../src/shared/interfaces"

type Props = {
  apiConfiguration?: APIConfiguration
  ollamaModels: string[]
  handleInputChange: (key: keyof APIConfiguration) => (e: any) => void
}

function APIOptionsOllama(props: Props) {
  const { apiConfiguration, ollamaModels, handleInputChange } = props
  return (
    <div>
      <VSCodeTextField
        value={apiConfiguration?.ollamaBaseUrl || ""}
        style={{ width: "100%" }}
        type="url"
        onInput={handleInputChange("ollamaBaseUrl")}
        placeholder={"Default: http://localhost:11434"}>
        <span style={{ fontWeight: 500 }}>Base URL (optional)</span>
      </VSCodeTextField>
      <VSCodeTextField
        value={apiConfiguration?.ollamaModelId || ""}
        style={{ width: "100%" }}
        onInput={handleInputChange("ollamaModelId")}
        placeholder={"e.g. llama3.1"}>
        <span style={{ fontWeight: 500 }}>Model ID</span>
      </VSCodeTextField>
      {ollamaModels.length > 0 && (
        <VSCodeRadioGroup
          value={ollamaModels.includes(apiConfiguration?.ollamaModelId || "") ? apiConfiguration?.ollamaModelId : ""}
          onChange={(e) => {
            const value = (e.target as HTMLInputElement)?.value
            // need to check value first since radio group returns empty string sometimes
            if (value) {
              handleInputChange("ollamaModelId")({
                target: { value },
              })
            }
          }}>
          {ollamaModels.map((model) => (
            <VSCodeRadio key={model} value={model} checked={apiConfiguration?.ollamaModelId === model}>
              {model}
            </VSCodeRadio>
          ))}
        </VSCodeRadioGroup>
      )}
      <p
        style={{
          fontSize: "12px",
          marginTop: "5px",
          color: "var(--vscode-descriptionForeground)",
        }}>
        Ollama allows you to run models locally on your computer. For instructions on how to get started, see their
        <VSCodeLink
          href="https://github.com/ollama/ollama/blob/main/README.md"
          style={{ display: "inline", fontSize: "inherit" }}>
          quickstart guide.
        </VSCodeLink>
        <span style={{ color: "var(--vscode-errorForeground)" }}>
          (<span style={{ fontWeight: 500 }}>Note:</span> Codey uses complex prompts and works best with Claude models.
          Less capable models may not work as expected.)
        </span>
      </p>
    </div>
  )
}

export default APIOptionsOllama
