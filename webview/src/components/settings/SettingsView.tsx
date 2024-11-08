import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDropdown,
  VSCodeLink,
  VSCodeOption,
  VSCodeTextArea,
} from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useState } from "react"
import { useConfig } from "../../context/ConfigContext"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { validateApiConfiguration, validateModelId } from "../../utils/validate"
import { vscode } from "../../utils/vscode"
import ApiOptions from "./ApiOptions"

const IS_DEV = true // FIXME: use flags when packaging

type SettingsViewProps = {
  onDone: () => void
}

const SettingsView = ({ onDone }: SettingsViewProps) => {
  const {
    apiConfiguration,
    version,
    customInstructions,
    setCustomInstructions,
    alwaysAllowReadOnly,
    setAlwaysAllowReadOnly,
    editAutoScroll,
    setEditAutoScroll,
    openRouterModels,
  } = useExtensionState()

  const config = useConfig()
  const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
  const [modelIdErrorMessage, setModelIdErrorMessage] = useState<string | undefined>(undefined)

  const handleSubmit = () => {
    const apiValidationResult = validateApiConfiguration(apiConfiguration)
    const modelIdValidationResult = validateModelId(apiConfiguration, openRouterModels)

    setApiErrorMessage(apiValidationResult)
    setModelIdErrorMessage(modelIdValidationResult)
    if (!apiValidationResult && !modelIdValidationResult) {
      vscode.postMessage({ type: "apiConfiguration", apiConfiguration })
      vscode.postMessage({ type: "customInstructions", text: customInstructions })
      vscode.postMessage({ type: "alwaysAllowReadOnly", bool: alwaysAllowReadOnly })
      vscode.postMessage({ type: "editAutoScroll", bool: editAutoScroll })
      onDone()
    }
  }

  useEffect(() => {
    setApiErrorMessage(undefined)
    setModelIdErrorMessage(undefined)
  }, [apiConfiguration])

  const handleResetState = () => {
    vscode.postMessage({ type: "resetState" })
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        padding: "10px 0px 0px 20px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "17px",
          paddingRight: 17,
        }}>
        <h3 style={{ color: "var(--vscode-foreground)", margin: 0 }}>Settings</h3>
        <VSCodeButton onClick={handleSubmit}>Done</VSCodeButton>
      </div>
      <div style={{ flexGrow: 1, overflowY: "scroll", paddingRight: 8, display: "flex", flexDirection: "column" }}>
        <div style={{ marginBottom: 5 }}>
          <ApiOptions
            showModelOptions={true}
            apiErrorMessage={apiErrorMessage}
            modelIdErrorMessage={modelIdErrorMessage}
          />
        </div>

        <div style={{ marginBottom: 5 }}>
          <VSCodeTextArea
            value={customInstructions ?? ""}
            style={{ width: "100%" }}
            rows={4}
            placeholder={'e.g. "Run unit tests at the end", "Use TypeScript with async/await", "Speak in Spanish"'}
            onInput={(e: any) => setCustomInstructions(e.target?.value ?? "")}>
            <span style={{ fontWeight: "500" }}>Custom Instructions</span>
          </VSCodeTextArea>
          <p
            style={{
              fontSize: "12px",
              marginTop: "5px",
              color: "var(--vscode-descriptionForeground)",
            }}>
            These instructions are added to the end of the system prompt sent with every request.
          </p>
        </div>

        <div style={{ marginBottom: 5 }}>
          <VSCodeCheckbox checked={alwaysAllowReadOnly} onChange={(e: any) => setAlwaysAllowReadOnly(e.target.checked)}>
            <span style={{ fontWeight: "500" }}>Always approve read-only operations</span>
          </VSCodeCheckbox>
          <p
            style={{
              fontSize: "12px",
              marginTop: "5px",
              color: "var(--vscode-descriptionForeground)",
            }}>
            When enabled, Codey will automatically read files, view directories, and inspect sites without requiring you
            to click the Approve button.
          </p>
        </div>

        <div style={{ marginBottom: 5 }}>
          <VSCodeCheckbox checked={editAutoScroll} onChange={(e: any) => setEditAutoScroll(e.target.checked)}>
            <span style={{ fontWeight: "500" }}>Auto Scroll when editing</span>
          </VSCodeCheckbox>
          <p
            style={{
              fontSize: "12px",
              marginTop: "5px",
              color: "var(--vscode-descriptionForeground)",
            }}>
            When enabled, Codey will automatically scroll the editor to the line that's currently being edited, so you
            can follow changed in real time. Toggle this off if you want to manually scroll the editor during Codey's
            edit.
          </p>
        </div>

        <div style={{ marginBottom: 5 }}>
          <VSCodeTextArea
            value={config.maxFileLineThreshold?.toString() ?? ""}
            style={{ width: "100%" }}
            rows={1}
            placeholder={"1000"}
            onInput={(e) => config.setMaxFileLineThreshold(Number((e.target as HTMLSelectElement)?.value ?? 0))}>
            <span style={{ fontWeight: "500" }}>Max Line Threshold</span>
          </VSCodeTextArea>
          <p
            style={{
              fontSize: "12px",
              marginTop: "5px",
              color: "var(--vscode-descriptionForeground)",
            }}>
            The maximum number of lines Codey will read from a file. If a file exceeds this threshold, Codey will read
            the top level definitions of the file (eg. classes, functions, methods, etc.). Zero means no limit
          </p>
        </div>

        <div className="dropdown-container">
          <label htmlFor="directory-context">
            <span style={{ fontWeight: 500 }}>Project Context Mode</span>
          </label>
          <div style={{ marginBottom: 5 }}>
            <VSCodeDropdown
              id="directory-context"
              value={config.directoryContextMode}
              onChange={(e) =>
                config.setDirectoryContextMode(((e.target as HTMLSelectElement)?.value ?? "tree") as "files" | "tree")
              }
              style={{ width: "100%", position: "relative" }}>
              <VSCodeOption value="files">Files</VSCodeOption>
              <VSCodeOption value="tree">Directory Tree</VSCodeOption>
            </VSCodeDropdown>
            <p
              style={{
                fontSize: "12px",
                marginTop: "5px",
                color: "var(--vscode-descriptionForeground)",
              }}>
              How to give Codey context about the project. `Tree` will show the directory tree as in `tree -L 2` and
              `Files` will show the files in the directory.
            </p>
          </div>
        </div>

        {IS_DEV && (
          <>
            <div style={{ marginTop: "10px", marginBottom: "4px" }}>Debug</div>
            <VSCodeButton onClick={handleResetState} style={{ marginTop: "5px", width: "auto" }}>
              Reset State
            </VSCodeButton>
            <p
              style={{
                fontSize: "12px",
                marginTop: "5px",
                color: "var(--vscode-descriptionForeground)",
              }}>
              This will reset all global state and secret storage in the extension.
            </p>
          </>
        )}

        <div
          style={{
            textAlign: "center",
            color: "var(--vscode-descriptionForeground)",
            fontSize: "12px",
            lineHeight: "1.2",
            marginTop: "auto",
            padding: "10px 8px 15px 0px",
          }}>
          <p style={{ wordWrap: "break-word", margin: 0, padding: 0 }}>
            If you have any questions or feedback, feel free to open an issue at{" "}
            <VSCodeLink href="https://github.com/ccrvlh/codey" style={{ display: "inline" }}>
              https://github.com/ccrvlh/codey
            </VSCodeLink>
          </p>
          <p style={{ fontStyle: "italic", margin: "10px 0 0 0", padding: 0 }}>v{version}</p>
        </div>
      </div>
    </div>
  )
}

export default memo(SettingsView)
