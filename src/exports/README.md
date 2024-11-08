# Codey API

The Codey extension exposes an API that can be used by other extensions. To use this API in your extension:

1. Copy `src/extension-api/codey.d.ts` to your extension's source directory.
2. Include `codey.d.ts` in your extension's compilation.
3. Get access to the API with the following code:

   ```ts
   const codeyExtension = vscode.extensions.getExtension<CodeyAPI>("ccrvlh.codey")

   if (!codeyExtension?.isActive) {
     throw new Error("Codey extension is not activated")
   }

   const codey = codeyExtension.exports

   if (codey) {
     // Now you can use the API

     // Set custom instructions
     await codey.setCustomInstructions("Talk like a pirate")

     // Get custom instructions
     const instructions = await codey.getCustomInstructions()
     console.log("Current custom instructions:", instructions)

     // Start a new task with an initial message
     await codey.startNewTask("Hello, Codey! Let's make a new project...")

     // Start a new task with an initial message and images
     await codey.startNewTask("Use this design language", ["data:image/webp;base64,..."])

     // Send a message to the current task
     await codey.sendMessage("Can you fix the @problems?")

     // Simulate pressing the primary button in the chat interface (e.g. 'Save' or 'Proceed While Running')
     await codey.pressPrimaryButton()

     // Simulate pressing the secondary button in the chat interface (e.g. 'Reject')
     await codey.pressSecondaryButton()
   } else {
     console.error("Codey API is not available")
   }
   ```

   **Note:** To ensure that the `ccrvlh.codey` extension is activated before your extension, add it to the `extensionDependencies` in your `package.json`:

   ```json
   "extensionDependencies": [
       "ccrvlh.codey"
   ]
   ```

For detailed information on the available methods and their usage, refer to the `codey.d.ts` file.
