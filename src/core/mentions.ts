import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import * as vscode from "vscode"
import { diagnosticsToProblemsString } from "../integrations/diagnostics"
import { extractTextFromFile } from "../integrations/misc/extract-text"
import { openFile } from "../integrations/misc/open-file"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { MENTION_REGEX_GLOBAL } from "../shared/mentions"


/**
 * Retrieves the content of a file or directory specified by the given path.
 * 
 * If the path points to a file, it reads the file content. If the file is binary,
 * it returns a message indicating that the content cannot be displayed.
 * 
 * If the path points to a directory, it lists the directory contents. For each file
 * in the directory, it attempts to read the file content unless the file is binary.
 * 
 * @param mentionPath - The relative path to the file or directory.
 * @param cwd - The current working directory to resolve the absolute path.
 * @returns A promise that resolves to a string containing the content of the file or directory.
 * @throws An error if the path cannot be accessed or read.
 */
async function getPathContent(mentionPath: string, cwd: string): Promise<string> {
  const absPath = path.resolve(cwd, mentionPath)

  try {
    const stats = await fs.stat(absPath)

    if (stats.isFile()) {
      const isBinary = await isBinaryFile(absPath).catch(() => false)
      if (isBinary) {
        return "(Binary file, unable to display content)"
      }
      const content = await extractTextFromFile(absPath)
      return content
    } else if (stats.isDirectory()) {
      const entries = await fs.readdir(absPath, { withFileTypes: true })
      let folderContent = ""
      const fileContentPromises: Promise<string | undefined>[] = []
      entries.forEach((entry, index) => {
        const isLast = index === entries.length - 1
        const linePrefix = isLast ? "└── " : "├── "
        if (entry.isFile()) {
          folderContent += `${linePrefix}${entry.name}\n`
          const filePath = path.join(mentionPath, entry.name)
          const absoluteFilePath = path.resolve(absPath, entry.name)
          // const relativeFilePath = path.relative(cwd, absoluteFilePath);
          fileContentPromises.push(
            (async () => {
              try {
                const isBinary = await isBinaryFile(absoluteFilePath).catch(() => false)
                if (isBinary) {
                  return undefined
                }
                const content = await extractTextFromFile(absoluteFilePath)
                return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
              } catch (error) {
                return undefined
              }
            })()
          )
        } else if (entry.isDirectory()) {
          folderContent += `${linePrefix}${entry.name}/\n`
          // not recursively getting folder contents
        } else {
          folderContent += `${linePrefix}${entry.name}\n`
        }
      })
      const fileContents = (await Promise.all(fileContentPromises)).filter((content) => content)
      return `${folderContent}\n${fileContents.join("\n\n")}`.trim()
    } else {
      return `(Failed to read contents of ${mentionPath})`
    }
  } catch (error) {
    throw new Error(`Failed to access path "${mentionPath}": ${error.message}`)
  }
}

/**
 * Retrieves the workspace problems (errors and warnings) as a string.
 *
 * @param cwd - The current working directory to filter the diagnostics.
 * @returns A string representation of the workspace problems. If no errors or warnings are detected, returns "No errors or warnings detected."
 */
function getWorkspaceProblems(cwd: string): string {
  const diagnostics = vscode.languages.getDiagnostics()
  const result = diagnosticsToProblemsString(
    diagnostics,
    [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
    cwd
  )
  if (!result) {
    return "No errors or warnings detected."
  }
  return result
}

/**
 * Opens a mention based on the provided string.
 * 
 * This function handles different types of mentions:
 * - If the mention starts with "/", it treats it as a relative path within the workspace.
 *   - If the mention ends with "/", it reveals the directory in the explorer.
 *   - Otherwise, it opens the file at the resolved path.
 * - If the mention is "problems", it opens the problems view in the workbench.
 * - If the mention starts with "http", it opens the URL in the default web browser.
 * 
 * vscode.commands.executeCommand("vscode.openFolder", , { forceNewWindow: false }) opens in new window
 * 
 * @param mention - The mention string to be processed. It can be a relative path, 
 *                  a special keyword like "problems", or a URL.
 */
export function openMention(mention?: string): void {
  if (!mention) {
    return
  }

  if (mention.startsWith("/")) {
    const relPath = mention.slice(1)
    const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
    if (!cwd) {
      return
    }
    const absPath = path.resolve(cwd, relPath)
    if (mention.endsWith("/")) {
      vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(absPath))
    } else {
      openFile(absPath)
    }
  } else if (mention === "problems") {
    vscode.commands.executeCommand("workbench.actions.view.problems")
  } else if (mention.startsWith("http")) {
    vscode.env.openExternal(vscode.Uri.parse(mention))
  }
}

/**
 * Parses mentions in the given text and fetches content for recognized mentions.
 * 
 * @param text - The text containing mentions to be parsed.
 * @param cwd - The current working directory to resolve relative paths.
 * @param urlContentFetcher - An instance of UrlContentFetcher to fetch content from URLs.
 * @returns A promise that resolves to the parsed text with fetched content included.
 * 
 * The function recognizes the following types of mentions:
 * - URLs starting with "http": Fetches the content of the URL and includes it in the parsed text.
 * - Paths starting with "/": Fetches the content of the file or folder at the given path and includes it in the parsed text.
 * - The keyword "problems": Fetches workspace diagnostics and includes them in the parsed text.
 * 
 * The fetched content is included in the parsed text within custom tags:
 * - `<url_content url="...">...</url_content>` for URL content.
 * - `<folder_content path="...">...</folder_content>` for folder content.
 * - `<file_content path="...">...</file_content>` for file content.
 * - `<workspace_diagnostics>...</workspace_diagnostics>` for workspace diagnostics.
 * 
 * If an error occurs while fetching content, an error message is included in the parsed text.
 */
export async function parseMentions(text: string, cwd: string, urlContentFetcher: UrlContentFetcher): Promise<string> {
  const mentions: Set<string> = new Set()
  let parsedText = text.replace(MENTION_REGEX_GLOBAL, (match, mention) => {
    mentions.add(mention)
    if (mention.startsWith("http")) {
      return `'${mention}' (see below for site content)`
    } else if (mention.startsWith("/")) {
      const mentionPath = mention.slice(1) // Remove the leading '/'
      return mentionPath.endsWith("/")
        ? `'${mentionPath}' (see below for folder content)`
        : `'${mentionPath}' (see below for file content)`
    } else if (mention === "problems") {
      return `Workspace Problems (see below for diagnostics)`
    }
    return match
  })

  const urlMention = Array.from(mentions).find((mention) => mention.startsWith("http"))
  let launchBrowserError: Error | undefined
  if (urlMention) {
    try {
      await urlContentFetcher.launchBrowser()
    } catch (error) {
      launchBrowserError = error
      vscode.window.showErrorMessage(`Error fetching content for ${urlMention}: ${error.message}`)
    }
  }

  for (const mention of mentions) {
    if (mention.startsWith("http")) {
      let result: string
      if (launchBrowserError) {
        result = `Error fetching content: ${launchBrowserError.message}`
      } else {
        try {
          const markdown = await urlContentFetcher.urlToMarkdown(mention)
          result = markdown
        } catch (error) {
          vscode.window.showErrorMessage(`Error fetching content for ${mention}: ${error.message}`)
          result = `Error fetching content: ${error.message}`
        }
      }
      parsedText += `\n\n<url_content url="${mention}">\n${result}\n</url_content>`
    } else if (mention.startsWith("/")) {
      const mentionPath = mention.slice(1)
      try {
        const content = await getPathContent(mentionPath, cwd)
        if (mention.endsWith("/")) {
          parsedText += `\n\n<folder_content path="${mentionPath}">\n${content}\n</folder_content>`
        } else {
          parsedText += `\n\n<file_content path="${mentionPath}">\n${content}\n</file_content>`
        }
      } catch (error) {
        if (mention.endsWith("/")) {
          parsedText += `\n\n<folder_content path="${mentionPath}">\nError fetching content: ${error.message}\n</folder_content>`
        } else {
          parsedText += `\n\n<file_content path="${mentionPath}">\nError fetching content: ${error.message}\n</file_content>`
        }
      }
    } else if (mention === "problems") {
      try {
        const problems = getWorkspaceProblems(cwd)
        parsedText += `\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
      } catch (error) {
        parsedText += `\n\n<workspace_diagnostics>\nError fetching diagnostics: ${error.message}\n</workspace_diagnostics>`
      }
    }
  }

  if (urlMention) {
    try {
      await urlContentFetcher.closeBrowser()
    } catch (error) {
      console.error(`Error closing browser: ${error.message}`)
    }
  }

  return parsedText
}
