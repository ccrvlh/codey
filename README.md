# Codey (Cline fork)

This is a very simple fork from Cline (prev. Claude Dev).

> [!WARNING]  
> This is under active development, untested, unstable, and not ready for production. Use at your own risk.

## Motivation

Cline is amazing - the experince within the IDE, the robustness when keeping conversation threads consistent, the feedback loop, etc. However, my experience on using it in "real life" projects, has been less then ideal. It's main approach to interact with existing code is full file rewrites. That means:

(1) Slow: for anything over 100-200 lines, you need to wait for the LLM to rewrite the whole file when all it needed was adding a line. You are also stuck with reading full files (which is also slow) or not reading them at all.

(2) Expensive: because it always needs to rewrite the whole file, you are paying for all tokens within the file, when all you needed was one. Same thing goes when reading files, you are paying for all tokens, when all you needed was a small part of it for the LLM to understand the context.

(3) Error Prone: when it handles existing production code, most of the code already works, and Cline was constantly breaking things, requiring manual intervention. Some custom instructions helped, but at the end, I wasn't to prevent it from changing things

At the end of the day, I wasn't able to be productive with it, my Anthropic bill sky rocketed, was constantly reaching API limits, and wasn't getting much done.

## Design

The fork is very simple. Apart from some small refactoring, adjustments, renaming, etc, it adds a few things:

(1) `SEARCH & REPLACE` tool: which means that the LLM doesn't need to rewrite the file, but rather give a `search` block and a `replace` block, and this will be exactly like VSCode merge conflict UI, in which you are going to approve/reject the changes.

(2) `INSERT CODE BLOCK` tool: in which the LLM would give the position (eg. starting line) to where to add a piece of code, and the file, and only that part would be added, without needing to rewrite the whole thing

(3) `READ FILE (WITH RANGE)` tool: an adjustment of Cline's current read file approach that adds a new parameter allowing the LLM to select a specific range of lines to read.

Some other changes:

- Moves tools to a dedicated class/module
- Reorganize prompt formation and build
- Adds options for the user to set a threshold of what a "big" file is - if a file is too big, Codey returns only the topline definitions and some other small params
- Adds line numbers when reading files and definitions
- Better management on what to add to the environment details
- Refactor classes and methods into smaller pieces, hopefully making the codebase easier to understand and change
- (In Progress) Adds tests - Cline's interaction is fairly complex, and it can be challenging to understand all interactions and handling, idea is to make the codebase tested for easier changes and improvements in the future

## Results

I'm obviously biased, and I haven't made proper benchmarks and so this is just me sharing impressions. My experience has been very positive: changes are signifcantly faster, Claude 3.5 is very smart when navigating the project files, knowing what to read, and where to add stuff. It's increadibly cheaper, I'm almost back at normal spending levels, since that are signifcantly less tokens moving around, which also means I haven't been rate limited at all since I started using this. All in all, I happy with it's performance. I ran into a couple of scenarios where a full file rewrite was being done, and it shouldn't, and this is where polishing the prompt comes in, and only testing and time is going to solve that, but I'm ok with it so far. It's not as polished when it comes to the interactions, some restrictions:

- Insert code block fake streams: it doesn't stream in real time, only after all the chunks are processed
- Search and replace sometimes uses too large blocks
- Search and replace sometimes get a wrong line break making formatting weird
- If you have multiple rounds of changes, the last ones are tricky to get right, since Codey depends a lot more on positioning (eg. which line to insert the code block)
- Have seen bugs where multiple tools were being called, and none of them were being executed (fxied in 0.1.8 i think)

Anyways, I'm happy with it, and it will continue to be my daily driver.
Still need to spend more time with other models both closed and open ones to see how it performs.

At this point, the code base is just too different, so won't be able to merge back to Cline, or merge from Cline, I'd be happy to share changes and contribute if anyone think it would be worth it. I haven't added anything related to the computer use capabilities, since I don't use it, but I'm happy to add it if someone wants to use it.

## Installation

I had to change the name and the logo to be able to have this and Cline at the same time, the idea is _not_ to build a parallel project, and I'd still encourage everyone to keep using Cline, so I won't be publishing this to the marketplace. However, if you want to test it locally you just need to clone the repo, build the package and install the VSIX:

```bash
# Clone the repo
git clone https://github.com/ccrvlh/codey

# Cd into the folder
cd codey

# Install deps
npm install

# Build the package
vsce package
```

Once you do that, you'll have a `codey-x.x.x.vsix` file on the root of the project. You just right click and "Install VSIX" and the little rocket will appear.

`vsce` is usually global, so you might need to install it:

```bash
npm install -g @vscode/vsce
```

If you want to run tests:

```bash
npm run test
```

For now I just added a couple of tests for the message parser, and not for the tools, which is the most important part. I'll be adding more tests as I go.

If you want to fork this and make it your own and manage your own versions, there's a `make` target to make deployment and versioning easier:

```bash
make deploy
```

This will increment the version (asking you whether to increase patch/minor/major) and build the project, and then you can just install the VSIX again, it will understand it is a new version and just ask you to refresh the extension.

Leaving the original Cline README below for reference.

---

# Cline (prev. Claude Dev) – \#1 on OpenRouter

<p align="center">
  <img src="https://media.githubusercontent.com/media/cline/cline/main/assets/docs/demo.gif" width="100%" />
</p>

<div align="center">
<table>
<tbody>
<td align="center">
<a href="https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev" target="_blank"><strong>Download on VS Marketplace</strong></a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank"><strong>Join the Discord</strong></a>
</td>
<td align="center">
<a href="https://github.com/cline/cline/wiki" target="_blank"><strong>Docs</strong></a>
</td>
<td align="center">
<a href="https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank"><strong>Feature Requests</strong></a>
</td>
</tbody>
</table>
</div>

Meet Cline, an AI assistant that can use your **CLI** a**N**d **E**ditor.

Thanks to [Claude 3.5 Sonnet's agentic coding capabilities](https://www-cdn.anthropic.com/fed9cc193a14b84131812372d8d5857f8f304c52/Model_Card_Claude_3_Addendum.pdf), Cline can handle complex software development tasks step-by-step. With tools that let him create & edit files, explore large projects, use the browser, and execute terminal commands (after you grant permission), he can assist you in ways that go beyond code completion or tech support. While autonomous AI scripts traditionally run in sandboxed environments, this extension provides a human-in-the-loop GUI to approve every file change and terminal command, providing a safe and accessible way to explore the potential of agentic AI.

1. Enter your task and add images to convert mockups into functional apps or fix bugs with screenshots.
2. Cline starts by analyzing your file structure & source code ASTs, running regex searches, and reading relevant files to get up to speed in existing projects. By carefully managing what information is added to context, Cline can provide valuable assistance even for large, complex projects without overwhelming the context window.
3. Once Cline has the information he needs, he can:
   - Create and edit files + monitor linter/compiler errors along the way, letting him proactively fix issues like missing imports and syntax errors on his own.
   - Execute commands directly in your terminal and monitor their output as he works, letting him e.g., react to dev server issues after editing a file.
   - For web development tasks, Cline can launch the site in a headless browser, click, type, scroll, and capture screenshots + console logs, allowing him to fix runtime errors and visual bugs.
4. When a task is completed, Cline will present the result to you with a terminal command like `open -a "Google Chrome" index.html`, which you run with a click of a button.

> [!TIP]
> Use the `CMD/CTRL + Shift + P` shortcut to open the command palette and type "Cline: Open In New Tab" to open the extension as a tab in your editor. This lets you use Cline side-by-side with your file explorer, and see how he changes your workspace more clearly.

---

<img align="right" width="340" src="https://github.com/user-attachments/assets/3cf21e04-7ce9-4d22-a7b9-ba2c595e88a4">

### Use any API and Model

Cline supports API providers like OpenRouter, Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure, and GCP Vertex. You can also configure any OpenAI compatible API, or use a local model through LM Studio/Ollama. If you're using OpenRouter, the extension fetches their latest model list, allowing you to use the newest models as soon as they're available.

The extension also keeps track of total tokens and API usage cost for the entire task loop and individual requests, keeping you informed of spend every step of the way.

<!-- Transparent pixel to create line break after floating image -->

<img width="2000" height="0" src="https://github.com/user-attachments/assets/ee14e6f7-20b8-4391-9091-8e8e25561929"><br>

<img align="left" width="370" src="https://github.com/user-attachments/assets/81be79a8-1fdb-4028-9129-5fe055e01e76">

### Run Commands in Terminal

Thanks to the new [shell integration updates in VSCode v1.93](https://code.visualstudio.com/updates/v1_93#_terminal-shell-integration-api), Cline can execute commands directly in your terminal and receive the output. This allows him to perform a wide range of tasks, from installing packages and running build scripts to deploying applications, managing databases, and executing tests, all while adapting to your dev environment & toolchain to get the job done right.

For long running processes like dev servers, use the "Proceed While Running" button to let Cline continue in the task while the command runs in the background. As Cline works he’ll be notified of any new terminal output along the way, letting him react to issues that may come up, such as compile-time errors when editing files.

<!-- Transparent pixel to create line break after floating image -->

<img width="2000" height="0" src="https://github.com/user-attachments/assets/ee14e6f7-20b8-4391-9091-8e8e25561929"><br>

<img align="right" width="400" src="https://github.com/user-attachments/assets/c5977833-d9b8-491e-90f9-05f9cd38c588">

### Create and Edit Files

Cline can create and edit files directly in your editor, presenting you a diff view of the changes. You can edit or revert Cline's changes directly in the diff view editor, or provide feedback in chat until you're satisfied with the result. Cline also monitors linter/compiler errors (missing imports, syntax errors, etc.) so he can fix issues that come up along the way on his own.

All changes made by Cline are recorded in your file's Timeline, providing an easy way to track and revert modifications if needed.

<!-- Transparent pixel to create line break after floating image -->

<img width="2000" height="0" src="https://github.com/user-attachments/assets/ee14e6f7-20b8-4391-9091-8e8e25561929"><br>

<img align="left" width="370" src="https://github.com/user-attachments/assets/bc2e85ba-dfeb-4fe6-9942-7cfc4703cbe5">

### Use the Browser

With Claude 3.5 Sonnet's new [Computer Use](https://www.anthropic.com/news/3-5-models-and-computer-use) capability, Cline can launch a browser, click elements, type text, and scroll, capturing screenshots and console logs at each step. This allows for interactive debugging, end-to-end testing, and even general web use! This gives him autonomy to fixing visual bugs and runtime issues without you needing to handhold and copy-pasting error logs yourself.

Try asking Cline to "test the app", and watch as he runs a command like `npm run dev`, launches your locally running dev server in a browser, and performs a series of tests to confirm that everything works. [See a demo here.](https://x.com/sdrzn/status/1850880547825823989)

<!-- Transparent pixel to create line break after floating image -->

<img width="2000" height="0" src="https://github.com/user-attachments/assets/ee14e6f7-20b8-4391-9091-8e8e25561929"><br>

<img align="right" width="360" src="https://github.com/user-attachments/assets/7fdf41e6-281a-4b4b-ac19-020b838b6970">

### Add Context

- **`@url`:** Paste in a URL for the extension to fetch and convert to markdown, useful when you want to give Cline the latest docs
- **`@problems`:** Add workspace errors and warnings ('Problems' panel) for Cline to fix
- **`@file`:** Adds a file's contents so you don't have to waste API requests approving read file (+ type to search files)
- **`@folder`:** Adds folder's files all at once to speed up your workflow even more

## Contributing

To contribute to the project, start by exploring [open issues](https://github.com/cline/cline/issues) or checking our [feature request board](https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop). We'd also love to have you join our [Discord](https://discord.gg/cline) to share ideas and connect with other contributors.

<details>
<summary>Local Development Instructions</summary>

1. Clone the repository _(Requires [git-lfs](https://git-lfs.com/))_:
   ```bash
   git clone https://github.com/cline/cline.git
   ```
2. Open the project in VSCode:
   ```bash
   code cline
   ```
3. Install the necessary dependencies for the extension and webview-gui:
   ```bash
   npm run install:all
   ```
4. Launch by pressing `F5` (or `Run`->`Start Debugging`) to open a new VSCode window with the extension loaded. (You may need to install the [esbuild problem matchers extension](https://marketplace.visualstudio.com/items?itemName=connor4312.esbuild-problem-matchers) if you run into issues building the project.)

</details>

## License

[Apache 2.0 © 2024 Cline Bot Inc.](./LICENSE)
