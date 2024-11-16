import fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

/**
 * Prompts the user to select multiple image files and returns their data URLs.
 *
 * @returns {Promise<string[]>} A promise that resolves to an array of data URLs of the selected images.
 *
 * The function opens a dialog allowing the user to select multiple image files with the extensions
 * "png", "jpg", "jpeg", and "webp". If no files are selected, it returns an empty array.
 * For each selected file, it reads the file content, converts it to a base64-encoded string,
 * determines the MIME type, and constructs a data URL.
 */
export async function selectImages(): Promise<string[]> {
  const options: vscode.OpenDialogOptions = {
    canSelectMany: true,
    openLabel: "Select",
    filters: {
      Images: ["png", "jpg", "jpeg", "webp"], // supported by anthropic and openrouter
    },
  }

  const fileUris = await vscode.window.showOpenDialog(options)

  if (!fileUris || fileUris.length === 0) {
    return []
  }

  return await Promise.all(
    fileUris.map(async (uri) => {
      const imagePath = uri.fsPath
      const buffer = await fs.readFile(imagePath)
      const base64 = buffer.toString("base64")
      const mimeType = getMimeType(imagePath)
      const dataUrl = `data:${mimeType};base64,${base64}`
      return dataUrl
    })
  )
}

/**
 * Determines the MIME type of a file based on its extension.
 *
 * @param filePath - The path of the file whose MIME type is to be determined.
 * @returns The MIME type as a string.
 * @throws Will throw an error if the file extension is unsupported.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpeg":
    case ".jpg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }
}
