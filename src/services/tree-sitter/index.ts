import * as fs from "fs/promises"
import * as path from "path"
import { fileExistsAtPath } from "../../utils/fs"
import { listFiles } from "../glob/list-files"
import { LanguageParser, loadRequiredLanguageParsers } from "./parser"

/*
	TODO: implement caching behavior to avoid having to keep analyzing project for new tasks.
	*/
export async function parseSourceCodeForDefinitionsTopLevel(inputPath: string): Promise<string> {
	const pathExists = await fileExistsAtPath(path.resolve(inputPath))
	if (!pathExists) {
		console.error(`[ERROR] Path does not exist: ${inputPath}`)
		return "This path does not exist or you do not have permission to access it."
	}

	const stats = await fs.stat(inputPath)
	if (!stats.isDirectory() && !stats.isFile()) {
		console.error(`[ERROR] Path is neither a file nor a directory: ${inputPath}`)
		return "The provided path is neither a file nor a directory."
	}

	let filesToParse: string[] = [inputPath]
	if (stats.isDirectory()) {
		const [allFiles, _] = await listFiles(inputPath, false, 200)
		const separatedFiles = separateFiles(allFiles)
		filesToParse = separatedFiles.filesToParse
	}

	let result = ""
	const languageParsers = await loadRequiredLanguageParsers(filesToParse)

	// Parse specific files we have language parsers for
	for (const file of filesToParse) {
		try {
			const definitions = await parseFile(file, languageParsers)
			if (definitions) {
				result += `${path.relative(path.dirname(inputPath), file).toPosix()}\n${definitions}\n`
			}
		} catch (error) {
			console.error(`[ERROR] Error parsing file ${file}: ${error}`)
		}
	}
	return result ? result : "No source code definitions found."
}

function separateFiles(allFiles: string[]): { filesToParse: string[]; remainingFiles: string[] } {
	const extensions = [
		"js",
		"jsx",
		"ts",
		"tsx",
		"py",
		// Rust
		"rs",
		"go",
		// C
		"c",
		"h",
		// C++
		"cpp",
		"hpp",
		// C#
		"cs",
		// Ruby
		"rb",
		"java",
		"php",
		"swift",
	].map((e) => `.${e}`)
	const filesToParse = allFiles.filter((file) => extensions.includes(path.extname(file))).slice(0, 50) // 50 files max
	const remainingFiles = allFiles.filter((file) => !filesToParse.includes(file))
	return { filesToParse, remainingFiles }
}

/*
	Parsing files using tree-sitter

	1. Parse the file content into an AST (Abstract Syntax Tree) using the appropriate language grammar (set of rules that define how the components of a language like keywords, expressions, and statements can be combined to create valid programs).
	2. Create a query using a language-specific query string, and run it against the AST's root node to capture specific syntax elements.
			- We use tag queries to identify named entities in a program, and then use a syntax capture to label the entity and its name. A notable example of this is GitHub's search-based code navigation.
		- Our custom tag queries are based on tree-sitter's default tag queries, but modified to only capture definitions.
	3. Sort the captures by their position in the file, output the name of the definition, and format by i.e. adding "|----\n" for gaps between captured sections.

	This approach allows us to focus on the most relevant parts of the code (defined by our language-specific queries) and provides a concise yet informative view of the file's structure and key elements.

	- https://github.com/tree-sitter/node-tree-sitter/blob/master/test/query_test.js
	- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/query-test.js
	- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/helper.js
	- https://tree-sitter.github.io/tree-sitter/code-navigation-systems
	*/
async function parseFile(filePath: string, languageParsers: LanguageParser): Promise<string | undefined> {
	const fileContent = await fs.readFile(filePath, "utf8")
	const ext = path.extname(filePath).toLowerCase().slice(1)

	const { parser, query } = languageParsers[ext] || {}
	if (!parser || !query) {
		return `Unsupported file type: ${filePath}`
	}

	let formattedOutput = ""

	try {
		// Parse the file content into an Abstract Syntax Tree (AST), a tree-like representation of the code
		const tree = parser.parse(fileContent)

		// Apply the query to the AST and get the captures
		// Captures are specific parts of the AST that match our query patterns, each capture represents a node in the AST that we're interested in.
		const captures = query.captures(tree.rootNode)

		// Log captures for debugging
		console.debug(`[DEBUG] Captures for file ${filePath}:`, captures)

		// Sort captures by their start position
		captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

		// Split the file content into individual lines
		const lines = fileContent.split("\n")

		// Keep track of the last line we've processed
		let lastLine = -1

		captures.forEach((capture) => {
			const { node, name } = capture
			// Log each capture for debugging
			console.debug(`[DEBUG] Capture name: ${name}, Node:`, node)

			// Get the start and end lines of the current AST node
			const startLine = node.startPosition.row
			const endLine = node.endPosition.row
			// Once we've retrieved the nodes we care about through the language query, we filter for lines with definition names only.
			// name.startsWith("name.reference.") > refs can be used for ranking purposes, but we don't need them for the output
			// previously we did `name.startsWith("name.definition.")` but this was too strict and excluded some relevant definitions

			// Add separator if there's a gap between captures
			if (lastLine !== -1 && startLine > lastLine + 1) {
				formattedOutput += "\n"
			}
			// Only add the first line of the definition
			// query captures includes the definition name and the definition implementation, but we only want the name
			// (I found discrepencies in the naming structure for various languages, i.e. javascript names would be 'name' and typescript names would be 'name.definition)
			if (name.includes("name") && lines[startLine]) {
				formattedOutput += `│${startLine + 1}: ${lines[startLine]}\n`
			}
			// Adds all the captured lines
			// for (let i = startLine; i <= endLine; i++) {
			// 	formattedOutput += `│${lines[i]}\n`
			// }
			//}
			lastLine = endLine
		})
	} catch (error) {
		console.log(`Error parsing file: ${error}\n`)
	}

	if (formattedOutput.length > 0) {
		return `|----\n${formattedOutput}\n|----\n`
	}
	return undefined
}


/**
 * Extracts the full definition of a specific method, function, or class from a file
 * @param filePath Path to the source code file
 * @param definitionName Name of the definition to extract
 * @returns The full definition as a string, or undefined if not found
 */
export async function extractDefinition(
	filePath: string,
	definitionName: string
): Promise<string | undefined> {
	const fileContent = await fs.readFile(filePath, "utf8")
	const ext = path.extname(filePath).toLowerCase().slice(1)

	const languageParsers = await loadRequiredLanguageParsers([filePath])
	const { parser, query } = languageParsers[ext] || {}

	if (!parser || !query) {
		return undefined
	}

	try {
		const tree = parser.parse(fileContent)
		const captures = query.captures(tree.rootNode)
		const lines = fileContent.split("\n")

		// Group captures by their position to associate names with their definitions
		const definitionGroups = new Map<number, { name: string; node: any }>()

		captures.forEach((capture) => {
			const { node, name: captureName } = capture
			const startLine = node.startPosition.row

			// If this is a name capture, store it
			if (captureName.includes("name")) {
				const nodeName = lines[startLine].trim()
				if (nodeName.includes(definitionName)) {
					definitionGroups.set(startLine, { name: nodeName, node: null })
				}
			}
			// If this is a definition capture, associate it with the name
			else if (captureName.startsWith("definition.")) {
				const group = definitionGroups.get(startLine)
				if (group) {
					group.node = node
				}
			}
		})

		// Find the matching definition
		for (const group of definitionGroups.values()) {
			if (group.node) {
				const startLine = group.node.startPosition.row
				const endLine = group.node.endPosition.row
				const definition = lines.slice(startLine, endLine + 1).join("\n")
				return definition
			}
		}
	} catch (error) {
		console.error(`Error extracting definition: ${error}`)
	}

	return undefined
}
