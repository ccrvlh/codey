import {
  AssistantMessageContent,
  TextContent,
  ToolParamName,
  toolParamNames,
  ToolUse,
  ToolUseName,
  toolUseNames,
} from "../types"

export class AssistantMessageParser {
  private contentBlocks: AssistantMessageContent[] = []
  private currentTextContent: TextContent | undefined = undefined
  private currentTextContentStartIndex = 0
  private currentToolUse: ToolUse | undefined = undefined
  private currentToolUseStartIndex = 0
  private currentParamName: ToolParamName | undefined = undefined
  private currentParamValueStartIndex = 0
  private accumulator = ""

  /**
   * Handles parsing of tool use parameters.
   * Processes parameter values until their closing tags are found.
   */
  private handleParameterParsing(): void {
    if (!this.currentToolUse || !this.currentParamName) {
      return
    }

    const currentParamValue = this.accumulator.slice(this.currentParamValueStartIndex)
    const paramClosingTag = `</${this.currentParamName}>`

    if (currentParamValue.endsWith(paramClosingTag)) {
      this.currentToolUse.params[this.currentParamName] = currentParamValue
        .slice(0, -paramClosingTag.length)
        .trim()
      this.currentParamName = undefined
    }
  }

  /**
   * Handles parsing of tool use blocks.
   * Processes tool uses until their closing tags are found and handles special cases.
   */
  private handleToolUseParsing(): void {
    if (!this.currentToolUse) {
      return
    }

    const currentToolValue = this.accumulator.slice(this.currentToolUseStartIndex)
    const toolUseClosingTag = `</${this.currentToolUse.name}>`

    if (currentToolValue.endsWith(toolUseClosingTag)) {
      this.finalizeToolUse()
      return
    }

    this.checkForNewParameter()
    this.handleWriteToFileSpecialCase()
  }

  /**
   * Checks for and initializes new parameter parsing when a parameter opening tag is found.
   */
  private checkForNewParameter(): void {
    const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
    for (const paramOpeningTag of possibleParamOpeningTags) {
      if (this.accumulator.endsWith(paramOpeningTag)) {
        this.currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
        this.currentParamValueStartIndex = this.accumulator.length
        break
      }
    }
  }

  /**
   * Special case handling for write_to_file tool use where content may contain closing tags.
   */
  private handleWriteToFileSpecialCase(): void {
    if (!this.currentToolUse) {
      return
    }

    const contentParamName: ToolParamName = "content"
    if (this.currentToolUse.name === "write_to_file" && this.accumulator.endsWith(`</${contentParamName}>`)) {
      const toolContent = this.accumulator.slice(this.currentToolUseStartIndex)
      const contentStartTag = `<${contentParamName}>`
      const contentEndTag = `</${contentParamName}>`

      const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
      const contentEndIndex = toolContent.lastIndexOf(contentEndTag)

      if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
        this.currentToolUse.params[contentParamName] = toolContent
          .slice(contentStartIndex, contentEndIndex)
          .trim()
      }
    }
  }

  /**
   * Handles parsing of text content between tool uses.
   * @param currentIndex - Current position in the message string
   */
  private handleTextContentParsing(currentIndex: number): void {
    let didStartToolUse = this.checkForNewToolUse()

    if (!didStartToolUse) {
      if (this.currentTextContent === undefined) {
        this.currentTextContentStartIndex = currentIndex
      }
      this.currentTextContent = {
        type: "text",
        content: this.accumulator.slice(this.currentTextContentStartIndex).trim(),
        partial: true,
      }
    }
  }

  /**
   * Checks for and initializes new tool use parsing when a tool use opening tag is found.
   * @returns boolean indicating if a new tool use was started
   */
  private checkForNewToolUse(): boolean {
    const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)

    for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
      if (this.accumulator.endsWith(toolUseOpeningTag)) {
        this.initializeNewToolUse(toolUseOpeningTag)
        return true
      }
    }

    return false
  }

  /**
   * Initializes a new tool use and finalizes any current text content.
   * @param toolUseOpeningTag - The opening tag that triggered the new tool use
   */
  private initializeNewToolUse(toolUseOpeningTag: string): void {
    this.currentToolUse = {
      type: "tool_use",
      name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
      params: {},
      partial: true,
    }
    this.currentToolUseStartIndex = this.accumulator.length

    if (this.currentTextContent) {
      this.finalizeTextContent(toolUseOpeningTag)
    }
  }

  /**
   * Finalizes the current text content by removing partial tool use tags and adding to content blocks.
   * @param toolUseOpeningTag - The tool use opening tag to remove from the end of text content
   */
  private finalizeTextContent(toolUseOpeningTag: string): void {
    if (!this.currentTextContent) {
      return
    }

    const textContent: TextContent = {
      type: "text",
      content: this.currentTextContent.content
        .slice(0, -toolUseOpeningTag.slice(0, -1).length)
        .trim(),
      partial: false
    }

    this.contentBlocks.push(textContent)
    this.currentTextContent = undefined
  }

  /**
   * Finalizes a complete tool use by marking it as non-partial and adding to content blocks.
   */
  private finalizeToolUse(): void {
    if (!this.currentToolUse) {
      return
    }

    this.currentToolUse.partial = false
    this.contentBlocks.push(this.currentToolUse)
    this.currentToolUse = undefined
  }

  /**
   * Finalizes any partial content at the end of parsing.
   */
  private finalizePartialContent(): void {
    if (this.currentToolUse) {
      if (this.currentParamName) {
        this.currentToolUse.params[this.currentParamName] = this.accumulator
          .slice(this.currentParamValueStartIndex)
          .trim()
      }
      this.contentBlocks.push(this.currentToolUse)
    }

    if (this.currentTextContent) {
      this.contentBlocks.push(this.currentTextContent)
    }
  }

  /**
   * Parses an assistant message into structured content blocks.
   * @param assistantMessage - The raw message string to parse
   * @returns Array of parsed content blocks (tool uses and text content)
   */
  static parse(assistantMessage: string) {
    const parser = new AssistantMessageParser()
    for (let i = 0; i < assistantMessage.length; i++) {
      parser.accumulator += assistantMessage[i]

      if (parser.currentToolUse && parser.currentParamName) {
        parser.handleParameterParsing()
        continue
      }

      if (parser.currentToolUse) {
        parser.handleToolUseParsing()
        continue
      }

      parser.handleTextContentParsing(i)
    }

    parser.finalizePartialContent()
    return parser.contentBlocks
  }
}
