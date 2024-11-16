import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { arePathsEqual } from "../../utils/path"

/**
 * Opens an image from a data URI in VS Code.
 *
 * @param dataUri - The data URI of the image to open. It should be in the format `data:image/{format};base64,{data}`.
 * @returns A promise that resolves when the image is opened, or shows an error message if the data URI is invalid or an error occurs.
 */
export async function openImage(dataUri: string): Promise<void> {
  const matches = dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
  if (!matches) {
    vscode.window.showErrorMessage("Invalid data URI format")
    return
  }
  const [, format, base64Data] = matches
  const imageBuffer = Buffer.from(base64Data, "base64")
  const tempFilePath = path.join(os.tmpdir(), `temp_image_${Date.now()}.${format}`)
  try {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(tempFilePath), new Uint8Array(imageBuffer))
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(tempFilePath))
  } catch (error) {
    vscode.window.showErrorMessage(`Error opening image: ${error}`)
  }
}

/**
 * Opens a file in the editor given its absolute path. If the file is already open in a tab group that is not in the active editor's column,
 * it will close the existing tab (if not dirty) to avoid duplicating tabs.
 *
 * @param absolutePath - The absolute path of the file to open.
 * @returns A promise that resolves when the file is opened in the editor.
 *
 * @throws Will show an error message if the file could not be opened.
 */
export async function openFile(absolutePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(absolutePath)

    try {
      for (const group of vscode.window.tabGroups.all) {
        const existingTab = group.tabs.find(
          (tab) => tab.input instanceof vscode.TabInputText && arePathsEqual(tab.input.uri.fsPath, uri.fsPath)
        )
        if (existingTab) {
          const activeColumn = vscode.window.activeTextEditor?.viewColumn
          const tabColumn = vscode.window.tabGroups.all.find((group) => group.tabs.includes(existingTab))?.viewColumn
          if (activeColumn && activeColumn !== tabColumn && !existingTab.isDirty) {
            await vscode.window.tabGroups.close(existingTab)
          }
          break
        }
      }
    } catch {}

    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open file!`)
  }
}
