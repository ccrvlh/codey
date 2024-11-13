import * as assert from 'assert';
import { AgentMessageParser } from '../src/core/parser';

suite('AgentMessageParser Tests', () => {
  test('should parse plain text', () => {
    const message = 'Hello world';
    const result = AgentMessageParser.parse(message);

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], {
      type: 'text',
      content: 'Hello world',
      partial: true
    });
  });

  test('should handle multiple text blocks', () => {
    const message = 'First block\nSecond block';
    const result = AgentMessageParser.parse(message);

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], {
      type: 'text',
      content: 'First block\nSecond block',
      partial: true
    });
  });

  test('should parse basic tool use', () => {
    const message = '<read_file>\n<path>test.txt</path>\n</read_file>';
    const result = AgentMessageParser.parse(message);

    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], {
      type: 'text',
      content: '',
      partial: false
    })
    assert.deepStrictEqual(result[1], {
      type: 'tool_use',
      name: 'read_file',
      params: {
        path: 'test.txt'
      },
      partial: false
    });
  });

  test('should parse tool use with multiple parameters', () => {
    const message = '<search_files>\n<path>src</path>\n<regex>test</regex>\n<file_pattern>*.ts</file_pattern>\n</search_files>';
    const result = AgentMessageParser.parse(message);

    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], {
      type: 'text',
      content: '',
      partial: false
    })
    assert.deepStrictEqual(result[1], {
      type: 'tool_use',
      name: 'search_files',
      params: {
        path: 'src',
        regex: 'test',
        file_pattern: '*.ts'
      },
      partial: false
    });
  });

  test('should handle write_to_file special case', () => {
    const message = '<write_to_file>\n<path>test.txt</path>\n<content>\nfunction test() {\n  console.log("test");\n}\n</content>\n</write_to_file>';
    const result = AgentMessageParser.parse(message);

    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], {
      type: 'text',
      content: '',
      partial: false
    })
    assert.deepStrictEqual(result[1], {
      type: 'tool_use',
      name: 'write_to_file',
      params: {
        path: 'test.txt',
        content: 'function test() {\n  console.log("test");\n}'
      },
      partial: false
    });
  });
});