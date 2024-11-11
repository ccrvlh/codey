import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractDefinition, parseSourceCodeForDefinitionsTopLevel } from '../services/tree-sitter/index';

suite('Tree-sitter Service Test Suite', () => {
  test('parseSourceCodeForDefinitionsTopLevel - invalid path', async () => {
    const result = await parseSourceCodeForDefinitionsTopLevel('invalid/path');
    assert.strictEqual(result, 'This path does not exist or you do not have permission to access it.');
  });

  test('parseSourceCodeForDefinitionsTopLevel - valid file path', async () => {
    const filePath = path.resolve(__dirname, 'testFile.ts');
    await fs.writeFile(filePath, 'const a = 1;');
    const result = await parseSourceCodeForDefinitionsTopLevel(filePath);
    assert.strictEqual(result, 'No source code definitions found.');
    await fs.unlink(filePath);
  });

  test('parseSourceCodeForDefinitionsTopLevel - valid directory path', async () => {
    const dirPath = path.resolve(__dirname, 'testDir');
    await fs.mkdir(dirPath);
    const filePath = path.join(dirPath, 'testFile.ts');
    await fs.writeFile(filePath, 'const a = 1;');
    const result = await parseSourceCodeForDefinitionsTopLevel(dirPath);
    assert.strictEqual(result, 'No source code definitions found.');
    await fs.unlink(filePath);
    await fs.rmdir(dirPath);
  });

  test('extractDefinition - unsupported file type', async () => {
    const filePath = path.resolve(__dirname, 'testFile.txt');
    await fs.writeFile(filePath, 'This is a text file.');
    const result = await extractDefinition(filePath, 'test');
    assert.strictEqual(result, undefined);
    await fs.unlink(filePath);
  });

  test('extractDefinition - valid file with no matching definition', async () => {
    const filePath = path.resolve(__dirname, 'testFile.ts');
    await fs.writeFile(filePath, 'const a = 1;');
    const result = await extractDefinition(filePath, 'nonExistentDefinition');
    assert.strictEqual(result, undefined);
    await fs.unlink(filePath);
  });

  test('extractDefinition - valid file with matching definition', async () => {
    const filePath = path.resolve(__dirname, 'testFile.ts');
    await fs.writeFile(filePath, 'function test() { return 1; }');
    const result = await extractDefinition(filePath, 'test');
    assert.strictEqual(result, 'function test() { return 1; }');
    await fs.unlink(filePath);
  });
});