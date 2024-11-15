import * as assert from "assert"
import dedent from "dedent"
import { AgentMessageParser } from "../src/core/parser"

suite("AgentMessageParser Tests", () => {
  test("should parse plain text", () => {
    const message = "Hello world"
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 1)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "Hello world",
      partial: true,
    })
  })

  test("should handle multiple text blocks", () => {
    const message = "First block\nSecond block"
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 1)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "First block\nSecond block",
      partial: true,
    })
  })

  test("should parse tool after thinking", () => {
    const message = `<thinking>\ntest\n</thinking>\n\n<read_file>\n<path>test.txt</path>\n</read_file>`
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "<thinking>\ntest\n</thinking>",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "read_file",
      params: {
        path: "test.txt",
      },
      partial: false,
    })
  })

  test("should parse basic tool use", () => {
    const message = "<read_file>\n<path>test.txt</path>\n</read_file>"
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "read_file",
      params: {
        path: "test.txt",
      },
      partial: false,
    })
  })

  test("should parse tool use with multiple parameters", () => {
    const message =
      "<search_files>\n<path>src</path>\n<regex>test</regex>\n<file_pattern>*.ts</file_pattern>\n</search_files>"
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "search_files",
      params: {
        path: "src",
        regex: "test",
        file_pattern: "*.ts",
      },
      partial: false,
    })
  })

  test("should handle write_to_file special case", () => {
    const message =
      '<write_to_file>\n<path>test.txt</path>\n<content>\nfunction test() {\n  console.log("test");\n}\n</content>\n</write_to_file>'
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "write_to_file",
      params: {
        path: "test.txt",
        content: 'function test() {\n  console.log("test");\n}',
      },
      partial: false,
    })
  })

  test("should handle mixed content with text and tool use", () => {
    const message = dedent`Some text before\
      <read_file>\
      <path>test.txt </path>\
      </read_file>\
      Some text after
    `
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "Some text before",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "read_file",
      params: {
        path: "test.txt",
      },
      partial: false,
    })
  })

  test("should ignore multiple sequential tool uses", () => {
    const message = dedent`<read_file>\
      <path>first.txt</path>\
      </read_file>\
      <read_file>\
      <path>second.txt</path>\
      </read_file>
    `
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "read_file",
      params: {
        path: "first.txt",
      },
      partial: false,
    })
  })

  test("should handle empty and whitespace content", () => {
    const message = "   \\t  "
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 1)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "\\t",
      partial: true,
    })
  })

  test("should handle partial tool use content", () => {
    const message = dedent`Text before<read_file>\
    <path>test.txt
      `
    const result = AgentMessageParser.parse(message)

    assert.strictEqual(result.length, 2)
    assert.deepStrictEqual(result[0], {
      type: "text",
      content: "Text before",
      partial: false,
    })
    assert.deepStrictEqual(result[1], {
      type: "tool_use",
      name: "read_file",
      params: {
        path: "test.txt",
      },
      partial: true,
    })
  })
})
