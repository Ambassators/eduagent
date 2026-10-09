# Codex Voice Workspace

A local Windows and macOS Electron workspace with **subscription GPT-Live voice**, multiple open documents, a separate Codex **Think** thread, web research, staged document editing, and interactive presentations. It reuses your local Codex ChatGPT login. No API key is needed.

## Install or run

Windows x64: run `Codex-Voice-2.0.0-win-x64.exe`, or extract the Windows ZIP and launch `Codex Voice.exe`. The unsigned packages include Electron, Codex, and the document libraries; no Node installation is required.

For source builds on Windows or macOS 13+, install Node.js 24, then run `npm ci` and `npm start`. The Windows `.cmd` and Mac `.command` launchers do the same. macOS supports Intel and Apple Silicon through matching native dependencies. Mac runtime and packaging have not been verified on this Windows host.

```powershell
# Windows installer and portable ZIP
npm run dist:win -- --x64
```

```bash
# Build on the matching Mac
npm run dist:mac -- --arm64
npm run dist:mac -- --x64
```

`.github/workflows/build.yml` builds Windows x64 and both Mac architectures when this folder is a repository root. Public Mac distribution requires your own signing and notarization credentials.

## Files and automatic context

Open multiple files with **Open files**, Ctrl/Cmd+O, or drag and drop. Switch between the sidebar or document tabs. The selected file is automatically shared with voice as quiet context; you do not have to press Think to discuss it. File selection and PDF page changes also update the Think thread without starting a reasoning turn.

Supported previews and extraction:

- PDF: rendered pages with selectable text, pagination, zoom, extracted text, and form field information.
- Word DOCX: semantic rich preview with headings, tables, and embedded images. It is not a pixel-identical Word page layout.
- Legacy DOC and ODT: text preview and context; rewriting can create a new DOCX.
- TXT, Markdown, code, JSON, CSV, XML, and other text files: readable previews; TXT/Markdown/HTML can be edited in the workspace.
- RTF: text preview; direct editing is disabled to preserve its format.
- PNG/JPEG/WebP/GIF/BMP: image preview. Think can inspect the image visually.
- HTML/SVG: sanitized static preview. Only deliberately generated demonstrations execute scripts.
- Other binary formats can be opened as file metadata, with an explicit notice when no decoder exists.

Up to 40 open files, 100 MB per file. The first 500 PDF pages are indexed; later pages remain viewable and can be read individually by tools. Large documents send a bounded excerpt and current page as live context; Think can fetch other ranges. Scanned PDFs have no extracted text: their first page is provided as visual context to Think, and additional pages can be inspected with `read_file(includeImage:true)`. Voice receives their metadata and can delegate visual questions to Think. Password-protected/encrypted PDFs may not be editable.

## Voice and Think

Click **Start a conversation** and grant microphone access. GPT-Live receives microphone audio over WebRTC and returns generated speech. Mute input, mute output, or End releases the voice connection. Space starts voice or toggles input mute; Escape ends it. Speak naturally to interrupt; the explicit Interrupt & talk button reconnects voice on the same conversation thread.

The voice agent can delegate a request to the `think` function with an optional focused message. The tool queues work and returns immediately. Think already receives the complete spoken and typed transcript plus current file context. It runs in its own thread while voice continues, then shares verified results back with the voice session.

Use the green **Think** button to invoke it directly. A message is optional: without one, it reasons about the most recent request and current document. Enter sends; Shift+Enter adds a newline. Stop Think cancels its active turn and pending requests. Up to eight requests can be queued.

Preferences select the **backend model** from the account's model catalog, thinking effort, service voice, microphone, appearance, transparency, and default demonstration placement. Backend model changes apply to the next Think turn while preserving conversation context. The service selects the live voice model independently.

Think defaults to **GPT-6.1 Sol**, **Low** effort, and **Fast / Priority** enabled. Toggle Fast / Priority in Preferences → Think to use standard speed. The requested service tier is applied to thread creation and each Think turn; actual availability depends on the subscription service.

Enable **Voice agent tools** in Preferences → Voice to let the voice delegation bridge highlight, point, place PDF overlays, and manage quizzes directly, without queuing the separate Think worker. Saving reconnects voice with the selected tool set. Think always has the PDF and quiz tools available. Background Think and adaptive coaching run without completion toasts, processing notices, or automatic pane changes.

## Think tools

- `think`: the voice bridge starts the independent Think worker with an optional message.
- Built-in `web_search`: live research using the signed-in Codex backend, with source links in responses.
- `get_context`: current document context and open file IDs.
- `read_file`: text ranges, PDF pages, dimensions, forms, and optional page/image snapshots.
- `read_transcript`: full conversation entries, including words retained before compaction.
- `update_text`: stage a new text/Markdown/HTML version.
- `replace_word_text`: exact DOCX replacements while preserving existing OOXML structure and runs.
- `edit_pdf`: add text, highlights, rectangles, replace/append/remove pages, rotate pages, and fill supported form fields. Coordinates are points from the top-left; pages are one-based.
- `create_document`: create a PDF, DOCX, Markdown, or text working file.
- `show_text`: display Markdown explanations or research in a side view or popup.
- `show_demo`: display self-contained interactive HTML/CSS/JavaScript in a side view or popup.
- `get_pdf_view`: actual visible PDF bounds and text spans in CSS viewport pixels; optional page reveals that page.
- `show_pdf_overlay`: exactly two on-page types, `text` (plain text, Markdown, LaTeX, or Mermaid) and `embed` (self-contained HTML). Markdown also supports math and Mermaid fences. Reuse an overlay ID to move or replace it.
- `point_on_pdf`: position the voice dot on a page with an arrow to a target rectangle; optionally specify the dot position.
- `highlight_pdf_text`: match a quote, highlight its exact text spans, and automatically position the voice dot and arrow. Optional one-based page and occurrence disambiguate repeated quotes. Scanned PDFs use coordinate pointing instead.
- `clear_pdf_overlays`: clear temporary content and pointing, or remove a single annotation by ID.

PDF overlay coordinates use either `space: "screen"` for CSS pixels from the app viewport's top-left or `space: "page"` for fractions from 0 to 1. `get_pdf_view` supplies current screen bounds. The viewer converts placement to page fractions so overlays, highlights, and pointing track scrolling and zoom. These annotations never change PDF bytes or mark the document dirty; they last for the conversation and are cleared if a PDF is edited or closed. HTML interactives sit directly on the page in isolated frames with inline scripts/styles and no network or app access. Use each overlay's close button, return the voice dot with its close button, or **Clear overlays** in the PDF toolbar.

## Adaptive quizzes

Click **Create a quiz** while a study file is open, or ask the agent to make a question bank and start a quiz. Banks can be authored from the current document or supplied question-bank content. `create_question_bank` creates a bank, `start_quiz` selects initial questions, `read_quiz_stats` reads live performance, and `append_quiz_questions` adds questions to the back. Banks and quizzes last for the conversation.

Clicking an answer choice grades it immediately and keeps the question visible with a specific explanation for **every** option: why each distractor is wrong and why the correct choice is right. There is no separate Submit step. Click **Next question** when ready. Explanations can include source links that jump directly to a PDF page (including slides saved as PDF) and highlight a cited teaching passage. Source links switch to the referenced open file when necessary. Native PowerPoint page navigation is not supported; open those slides as PDF.

The panel shows accuracy, streak, and results by topic. Choice grading is deterministic; optional concise short answers use normalized exact accepted answers and Enter to check. Answer keys and choice rationales stay in the main process until grading.

With **Adaptive** enabled, an independent Codex quiz coach receives recent graded answers, topic performance, the question bank, and recent final user discussion. It quietly selects or authors useful follow-up questions and appends them to the queue. It cannot replace the current question or answered questions. Automatic additions are bounded to three per review, twelve per quiz, and ten remaining questions. Disable Adaptive or close the quiz to stop coaching. The voice agent receives a concise quiet update with current quiz context and performance so it can discuss the same exercise.

Arbitrary shell execution, unrelated filesystem access, plugins, MCP, and additional agents are disabled. Workspace tools resolve open file IDs; they do not execute model-generated commands. Unsupported permission requests are declined.

## Editing and presentations

Edits are staged in local working copies. **Save copy** chooses a destination. **Save original** updates an original only after you click it and creates a timestamped backup first. New and edited files show a working-copy indicator. Open file tabs and their working copies are retained across app restarts.

PDF text additions are overlays; replacing a page rebuilds that whole page. A painted rectangle does not securely remove underlying content and must not be described as redaction. Existing signed PDFs lose signature validity when modified. Forms remain interactive; they are not flattened.

Presentations appear in the **On screen** sidebar. Switch between results, open a popup, save HTML/Markdown, or close the side view. At narrower window widths, the demonstration replaces the agent panel; close the demonstration to return to Think.

Demonstrations are self-contained: inline scripts/styles only, with no network, Node, filesystem, or authentication access. The side iframe is sandboxed and presentations use a separate custom origin with a restrictive CSP. A popup has no app IPC bridge. External libraries should be embedded rather than loaded from a CDN.

## Background compaction and privacy

Transcript updates are injected into Think's history without an inference turn. When the configured context threshold is reached, compaction starts asynchronously on the Think thread. Voice remains connected. Pending Think requests wait for compaction; active work finishes before a requested compaction starts. Current document context is pinned again afterward. The complete transcript remains available to `read_transcript` for the running conversation even after model context is summarized.

The full voice transcript is held in memory until New conversation or app shutdown; the app does not record audio. Working documents and tab metadata are stored under the app's user-data conversation/files directory. Export writes the transcript only to your selected destination. Account tokens remain inside Codex and never enter the renderer or demonstration frames. `CODEX_HOME` and the local credential store are respected; ambient API-key variables are removed from the child process.

Windows Mica uses the native desktop background material. Acrylic and opaque modes are available; appearance follows the system by default. macOS uses native vibrancy for glass modes. Mica/Acrylic require supported Windows versions and can be affected by OS transparency/accessibility settings.

## Verification and troubleshooting

Manual checks covered production compilation, cached ChatGPT auth, live WebRTC audio/transcripts, PDF extraction/rendering/form values, staged PDF edits, DOCX replacements, text edits, multi-file switching, shared transcript context, real web research, dynamic workspace tools, interactive side/popup presentations, and asynchronous compaction. Production dependency audit reported no known vulnerabilities. No regression tests were created. Physical microphone/speaker quality and Mac runtime still need validation on your hardware.

If microphone access is denied, enable desktop-app microphone access in Windows privacy settings or Codex Voice in macOS Privacy & Security. For connection errors, check subscription availability, limits, workspace settings, and WebRTC connectivity, then End and reconnect. The experimental CLI voice flag does not bypass rollout restrictions. If a selected input device is missing, select System default.

If Codex is missing, run `npm ci` without omitting optional dependencies. A custom Codex path must point to the native executable. Subscription realtime and dynamic tool interfaces are experimental and may change with service or Codex updates.

Implementation: `src/main/documents.ts` owns extraction and staged edits; `src/main/think.ts` owns independent threads, history sync, tools, and compaction; `src/main/main.ts` owns sessions, IPC, permissions, native appearance, file dialogs, and popup/protocol hosting; `src/renderer` owns the workspace, viewers, microphone, and remote audio.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation), [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice), [Electron window materials](https://www.electronjs.org/docs/latest/api/base-window).

This is an independent application. Codex, Electron, PDF.js, document libraries, and the bundled OFL font retain their respective licenses.
