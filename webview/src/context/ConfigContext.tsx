import React, { createContext, useContext, useEffect, useState } from "react"
import type { AgentConfig } from "../../../src/core/config"
import { vscode } from "../utils/vscode"

interface ConfigContextType extends AgentConfig {
  setCustomInstructions: (value: string) => void
  setAlwaysAllowReadOnly: (value: boolean) => void
  setEditAutoScroll: (value: boolean) => void
  setMaxFileLineThreshold: (value: number) => void
  setMaxFileLineThresholdBehavior: (value: "truncate" | "definitions") => void
  setDirectoryContextMode: (value: "files" | "tree") => void
  setDirectoryContextMaxLines: (value: number) => void
  setMaxMistakeLimit: (value: number) => void
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined)

export const ConfigContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<AgentConfig>({
    customInstructions: "",
    alwaysAllowReadOnly: false,
    editAutoScroll: false,
    maxFileLineThreshold: 500,
    maxFileLineThresholdBehavior: "truncate",
    directoryContextMode: "files",
    directoryContextMaxLines: 200,
    maxMistakeLimit: 3,
  })

  // Listen for state updates from the extension
  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      const message = event.data
      if (message.type === "state") {
        setConfig((prevConfig) => ({
          ...prevConfig,
          customInstructions: message.state.customInstructions ?? "",
          alwaysAllowReadOnly: message.state.alwaysAllowReadOnly ?? false,
          editAutoScroll: message.state.editAutoScroll ?? false,
          maxFileLineThreshold: message.state.maxFileLineThreshold ?? 500,
          maxFileLineThresholdBehavior: message.state.maxFileLineThresholdBehavior ?? "truncate",
          directoryContextMode: message.state.directoryContextMode ?? "files",
          directoryContextMaxLines: message.state.directoryContextMaxLines ?? 200,
          maxMistakeLimit: message.state.maxMistakeLimit ?? 3,
        }))
      }
    }

    window.addEventListener("message", messageHandler)
    return () => window.removeEventListener("message", messageHandler)
  }, [])

  const contextValue: ConfigContextType = {
    ...config,
    setCustomInstructions: (value) => {
      setConfig((prev) => ({ ...prev, customInstructions: value }))
      vscode.postMessage({
        type: "customInstructions",
        text: value,
      })
    },
    setAlwaysAllowReadOnly: (value) => {
      setConfig((prev) => ({ ...prev, alwaysAllowReadOnly: value }))
      vscode.postMessage({
        type: "alwaysAllowReadOnly",
        bool: value,
      })
    },
    setEditAutoScroll: (value) => {
      setConfig((prev) => ({ ...prev, editAutoScroll: value }))
      vscode.postMessage({
        type: "editAutoScroll",
        bool: value,
      })
    },
    setMaxFileLineThreshold: (value) => {
      setConfig((prev) => ({ ...prev, maxFileLineThreshold: value }))
      vscode.postMessage({
        type: "maxFileLineThreshold",
        value: value,
      })
    },
    setMaxFileLineThresholdBehavior: (value) => {
      setConfig((prev) => ({ ...prev, maxFileLineThresholdBehavior: value }))
      vscode.postMessage({
        type: "maxFileLineThresholdBehavior",
        text: value,
      })
    },
    setDirectoryContextMode: (value) => {
      setConfig((prev) => ({ ...prev, directoryContextMode: value }))
      vscode.postMessage({
        type: "directoryContextMode",
        text: value,
      })
    },
    setDirectoryContextMaxLines: (value) => {
      setConfig((prev) => ({ ...prev, directoryContextMaxLines: value }))
      vscode.postMessage({
        type: "directoryContextMaxLines",
        value: value,
      })
    },
    setMaxMistakeLimit: (value) => {
      setConfig((prev) => ({ ...prev, maxMistakeLimit: value }))
      vscode.postMessage({
        type: "maxMistakeLimit",
        value: value,
      })
    },
  }

  return <ConfigContext.Provider value={contextValue}>{children}</ConfigContext.Provider>
}

export const useConfig = () => {
  const context = useContext(ConfigContext)
  if (context === undefined) {
    throw new Error("useConfig must be used within a ConfigContextProvider")
  }
  return context
}
