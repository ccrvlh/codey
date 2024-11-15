import * as vscode from 'vscode';

export class LanguageServerProvider {
  private fileUri: vscode.Uri;

  constructor(filePath: string) {
    this.fileUri = vscode.Uri.file(filePath);
  }

  /**
   * Lists the top-level symbols (e.g., classes, functions) and directly associated methods/attributes.
   * Does not delve into lower-level details within objects.
   */
  public async listTopLevelSymbols(): Promise<void> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      this.fileUri
    );

    if (!symbols) {
      console.error('No symbols found in the document.');
      return;
    }

    // Print top-level symbols and their direct children (methods/attributes)
    for (const symbol of symbols) {
      console.log(`Top-Level Object: ${symbol.name} (${vscode.SymbolKind[symbol.kind]})`);

      // List methods and attributes within top-level objects (e.g., class methods or function parameters)
      for (const child of symbol.children) {
        console.log(`  └─ ${child.name} (${vscode.SymbolKind[child.kind]})`);
      }
    }
  }

  /**
   * Retrieves the full definition of an object (class, method, function) by fully qualified name.
   * The qualifiedName should be in the format 'ClassName.methodName', 'FunctionName', etc.
   */
  public async getFullDefinition(qualifiedName: string): Promise<void> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      this.fileUri
    );

    if (!symbols) {
      console.error('No symbols found in the document.');
      return;
    }

    // Split the fully qualified name
    const nameParts = qualifiedName.split('.');
    let currentSymbols: vscode.DocumentSymbol[] | null = symbols;
    let foundSymbol: vscode.DocumentSymbol | null = null;

    for (const name of nameParts) {
      foundSymbol = this.findSymbolByName(currentSymbols, name);
      if (foundSymbol) {
        currentSymbols = foundSymbol.children;
      } else {
        console.error(`Symbol ${name} not found`);
        return;
      }
    }

    if (foundSymbol) {
      const document = await vscode.workspace.openTextDocument(this.fileUri);
      const definition = document.getText(foundSymbol.range);
      console.log(`Definition of ${qualifiedName}:\n${definition}`);
    }
  }

  /**
   * Renames a symbol (method, function, variable) and automatically updates all references.
   * This uses the rename provider to facilitate refactoring.
   */
  public async renameSymbol(oldName: string, newName: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(this.fileUri);
    const textEditor = await vscode.window.showTextDocument(document);

    // Use the `vscode.executeDocumentRenameProvider` to rename the symbol at a specific location
    const position = await this.findSymbolPositionByName(oldName);

    if (!position) {
      console.error(`Unable to locate the symbol to rename: ${oldName}`);
      return;
    }

    const renameResult = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      this.fileUri,
      position,
      newName
    );

    if (renameResult) {
      await vscode.workspace.applyEdit(renameResult);

      // Optionally save the file after renaming
      await textEditor.document.save();
      console.log(`Renamed ${oldName} to ${newName} successfully.`);
    } else {
      console.error(`Failed to rename ${oldName}.`);
    }
  }

  /**
   * Finds a top-level symbol by its name. You can extend this to include SymbolKind checks if needed.
   */
  private findSymbolByName(symbols: vscode.DocumentSymbol[] | null, name: string): vscode.DocumentSymbol | null {
    for (const symbol of symbols || []) {
      if (symbol.name === name) {
        return symbol;
      }
    }
    return null;
  }

  /**
   * Finds the position of a symbol by its name in the current file. This helps where we need to rename a symbol.
   */
  private async findSymbolPositionByName(symbolName: string): Promise<vscode.Position | null> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      this.fileUri
    );

    if (!symbols) {
      console.error('No symbols found in the document.');
      return null;
    }

    const symbol = this.findSymbolByName(symbols, symbolName);

    if (symbol) {
      // Return the position of the symbol's start
      return symbol.range.start;
    }

    return null;
  }
}