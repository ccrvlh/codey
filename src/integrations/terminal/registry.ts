import * as vscode from "vscode"

export interface TerminalInfo {
  terminal: vscode.Terminal
  busy: boolean
  lastCommand: string
  id: number
}

// Although vscode.window.terminals provides a list of all open terminals, there's no way to know whether they're busy or not (exitStatus does not provide useful information for most commands). In order to prevent creating too many terminals, we need to keep track of terminals through the life of the extension, as well as session specific terminals for the life of a task (to get latest unretrieved output).
// Since we have promises keeping track of terminal processes, we get the added benefit of keep track of busy terminals even after a task is closed.
export class TerminalRegistry {
  private static terminals: TerminalInfo[] = []
  private static nextTerminalId = 1

  constructor() {}

  /**
   * Creates a new terminal instance with the specified current working directory (cwd).
   * The terminal will be named "Codey" and will have a robot icon.
   *
   * @param cwd - The current working directory for the terminal. It can be a string, a vscode.Uri, or undefined.
   * @returns A TerminalInfo object containing the created terminal instance and its associated metadata.
   */
  static createTerminal(cwd?: string | vscode.Uri | undefined): TerminalInfo {
    const terminal = vscode.window.createTerminal({
      cwd,
      name: "Codey",
      iconPath: new vscode.ThemeIcon("robot"),
    })
    const newInfo: TerminalInfo = {
      terminal,
      busy: false,
      lastCommand: "",
      id: this.nextTerminalId++,
    }
    this.terminals.push(newInfo)
    return newInfo
  }

  /**
   * Retrieves the terminal information for the given terminal ID.
   * If the terminal is closed, it removes the terminal from the registry and returns `undefined`.
   *
   * @param id - The unique identifier of the terminal.
   * @returns The terminal information if found and open, otherwise `undefined`.
   */
  static getTerminal(id: number): TerminalInfo | undefined {
    const terminalInfo = this.terminals.find((t) => t.id === id)
    if (terminalInfo && this.isTerminalClosed(terminalInfo.terminal)) {
      this.removeTerminal(id)
      return undefined
    }
    return terminalInfo
  }

  /**
   * Updates the terminal information with the given updates.
   *
   * @param id - The unique identifier of the terminal to update.
   * @param updates - An object containing the partial updates to apply to the terminal.
   */
  static updateTerminal(id: number, updates: Partial<TerminalInfo>) {
    const terminal = this.getTerminal(id)
    if (terminal) {
      Object.assign(terminal, updates)
    }
  }

  /**
   * Removes a terminal from the registry based on the given ID.
   *
   * @param id - The unique identifier of the terminal to be removed.
   */
  static removeTerminal(id: number) {
    this.terminals = this.terminals.filter((t) => t.id !== id)
  }

  /**
   * Retrieves all active terminals by filtering out the closed ones.
   *
   * @returns {TerminalInfo[]} An array of TerminalInfo objects representing the active terminals.
   */
  static getAllTerminals(): TerminalInfo[] {
    this.terminals = this.terminals.filter((t) => !this.isTerminalClosed(t.terminal))
    return this.terminals
  }

  /**
   * Checks if the given terminal is closed.
   * The exit status of the terminal will be undefined while the terminal is active. (This value is set when onDidCloseTerminal is fired.)
   *
   * @param terminal - The terminal to check.
   * @returns `true` if the terminal is closed, otherwise `false`.
   */
  private static isTerminalClosed(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus !== undefined
  }
}
