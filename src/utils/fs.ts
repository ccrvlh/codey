import Anthropic from "@anthropic-ai/sdk"
import fs from "fs/promises"
import * as path from "path"
import { GlobalFileNames } from "./const"

/**
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
  const newDirectories: string[] = []
  const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
  const directoryPath = path.dirname(normalizedFilePath)

  let currentPath = directoryPath
  const dirsToCreate: string[] = []

  // Traverse up the directory tree and collect missing directories
  while (!(await fileExistsAtPath(currentPath))) {
    dirsToCreate.push(currentPath)
    currentPath = path.dirname(currentPath)
  }

  // Create directories from the topmost missing one down to the target directory
  for (let i = dirsToCreate.length - 1; i >= 0; i--) {
    await fs.mkdir(dirsToCreate[i])
    newDirectories.push(dirsToCreate[i])
  }

  return newDirectories
}

/**
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Ensures that the task directory exists at the specified storage path.
 * If the directory does not exist, it will be created recursively.
 *
 * @param storagePath - The base path where the task directories are stored.
 * @param taskId - The unique identifier for the task.
 * @returns A promise that resolves to the path of the task directory.
 * @throws Will throw an error if the storage path is invalid.
 */
export async function ensureTaskDirectoryExists(storagePath: string, taskId: string): Promise<string> {
  if (!storagePath) {
    throw new Error("Global storage uri is invalid")
  }
  const taskDir = path.join(storagePath, "tasks", taskId)
  await fs.mkdir(taskDir, { recursive: true })
  return taskDir
}

/**
 * Retrieves the saved API conversation history for a given task.
 *
 * This function ensures that the task directory exists, constructs the file path
 * for the conversation history, and reads the file if it exists. If the file does
 * not exist, it returns an empty array.
 *
 * @param storagePath - The base path where task directories are stored.
 * @param taskId - The unique identifier for the task.
 * @returns A promise that resolves to an array of `Anthropic.MessageParam` objects
 * representing the conversation history.
 */
export async function getSavedApiConversationHistory(
  storagePath: string,
  taskId: string
): Promise<Anthropic.MessageParam[]> {
  const baseDir = await ensureTaskDirectoryExists(storagePath, taskId)
  const filePath = path.join(baseDir, GlobalFileNames.apiConversationHistory)
  const fileExists = await fileExistsAtPath(filePath)
  if (fileExists) {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  }
  return []
}
