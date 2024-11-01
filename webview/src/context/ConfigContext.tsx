import React, { createContext, useContext, useEffect, useState } from "react"
import { vscode } from "../utils/vscode"

interface ClineConfig {
  customInstructions?: string[]
  alwaysAllowReadOnly?: boolean
  editAutoScroll?: boolean
  maxFileLineThreshold?: number
  maxFileLineThresholdBehavior?: "truncate" | "definitions"
  directoryContextMode?: "files" | "tree"
  directoryContextMaxLines?: number
  maxMistakeLimit?: number
}

interface ConfigContextType extends ClineConfig {
  setCustomInstructions: (value: string[]) => void
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
  const [config, setConfig] = useState<ClineConfig>({
    customInstructions: [],
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
          customInstructions: message.state.customInstructions ? [message.state.customInstructions] : [],
          alwaysAllowReadOnly: message.state.alwaysAllowReadOnly ?? false,
          editAutoScroll: message.state.editAutoScroll ?? false,
          maxFileLineThreshold: message.state.maxFileLineThreshold ?? 500,
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
        text: value.join("\n"),
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
    // These setters update local state only for now
    setMaxFileLineThresholdBehavior: (value) => {
      setConfig((prev) => ({ ...prev, maxFileLineThresholdBehavior: value }))
    },
    setDirectoryContextMode: (value) => {
      setConfig((prev) => ({ ...prev, directoryContextMode: value }))
    },
    setDirectoryContextMaxLines: (value) => {
      setConfig((prev) => ({ ...prev, directoryContextMaxLines: value }))
    },
    setMaxMistakeLimit: (value) => {
      setConfig((prev) => ({ ...prev, maxMistakeLimit: value }))
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
