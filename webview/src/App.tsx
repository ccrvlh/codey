import { AppContent } from "./AppContent"
import { ConfigContextProvider } from "./context/ConfigContext"
import { ExtensionStateContextProvider } from "./context/ExtensionStateContext"

export default function App() {
  return (
    <ExtensionStateContextProvider>
      <ConfigContextProvider>
        <AppContent />
      </ConfigContextProvider>
    </ExtensionStateContextProvider>
  )
}
