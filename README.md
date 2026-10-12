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

In **Preferences → Window**, enable **Low power mode** for gentler microphone orb playback during voice. Normal mode plays the subtle fluid gradient at 60 fps, with soft edge shading; Low power mode uses the matching 30 fps loop. Both stay still when voice is off and pause when the window is unfocused, hidden, or minimized. Video playback also respects reduced motion and falls back to a still gradient if decoding fails. The choice is saved locally. The bundled video assets work across platforms; regenerate them on macOS with `npm run assets:orb-video`.

## Files and automatic context

Open multiple files with **Open files**, Ctrl/Cmd+O, or drag and drop. Switch between the sidebar or document tabs. The selected file is automatically shared with voice as quiet context; you do not have to press Think to discuss it. File selection and PDF page changes also update the Think thread without starting a reasoning turn.

Supported previews and extraction:

- PDF: rendered pages with selectable text, pagination, zoom, extracted text, and form field information.
- Word DOCX: semantic rich preview with headings, tables, and embedded images. It is not a pixel-identical Word page layout.
- Legacy DOC and ODT: text preview and context; rewriting can create a new DOCX.
- TXT, Markdown, code, JSON, CSV, XML, and other text files: readable previews; TXT/Markdown/HTML can be edited in the workspace.
- RTF: text preview; direct editing is disabled to preserve its format.
- TeX (`.tex`, `.ltx`, `.latex`): the integrated GlassTeX visual editor, full source editing, and local math calculations.
- PNG/JPEG/WebP/GIF/BMP: image preview. Think can inspect the image visually.
- HTML/SVG: sanitized static preview. Only deliberately generated demonstrations execute scripts.
- Other binary formats can be opened as file metadata, with an explicit notice when no decoder exists.

Up to 40 open files, 100 MB per file. The first 500 PDF pages are indexed; later pages remain viewable and can be read individually by tools. Large documents send a bounded excerpt and current page as live context; Think can fetch other ranges. Scanned PDFs have no extracted text: their first page is provided as visual context to Think, and additional pages can be inspected with `read_file(includeImage:true)`. Voice receives their metadata and can delegate visual questions to Think. Password-protected/encrypted PDFs may not be editable.

## GlassTeX

Opening a TeX file splits the left sidebar's available file area into two equal-height sections: files above, GlassTeX commands below. Both sections scroll independently. Switching to another file restores the usual file list. The command sidebar stays visible beside presentations at smaller window widths.

GlassTeX includes the original visual document editor and 443 feature templates, structural MathLive equations, prose, tables, lists, algorithm blocks, automatic equation detection, a bounded local solver, KaTeX preview, and LaTeX/JavaScript/TSX/JSON inspectors. Search or filter commands, create/edit/delete custom templates, and right-click a command to assign a shortcut or copy its template. Settings persist locally.

Use **Full source** to edit the whole document. Visual edits preserve unrelated source, comments, preamble, line endings, and Unicode. TeX files must be UTF-8 and at most 8 MiB. Edits persist immediately to the workspace working copy; **Save copy** and **Save original** use the app's existing save and backup workflow. Think can read and edit the current TeX working copy.

**Export to PDF** prints a separate snapshot of the GlassTeX rendering. It uses the bundled renderer; package processing and full TeX compilation are outside GlassTeX's rendering support. Unrecognized source fragments remain editable and preserved in the document.

Shortcuts: Cmd/Ctrl+Enter inserts an equation, Shift+Cmd/Ctrl+Enter inserts inline math, Cmd/Ctrl+K searches features, Shift+Cmd/Ctrl+L toggles source, Shift+Cmd/Ctrl+P toggles preview, and Shift+Cmd/Ctrl+I toggles the inspector. Cmd/Ctrl+S saves the original with a backup; Shift+Cmd/Ctrl+S saves a copy. Cmd/Ctrl+Alt+E exports PDF.

Run `npm test` for unit tests and `npm run test:glasstex` for the isolated Electron integration check. GlassTeX and its bundled MathLive/KaTeX licenses are retained in `src/renderer/public/glasstex`.

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

## Chromium browser and external web apps

Use **Browser** in the left rail to open the embedded Chromium workspace. It supports multiple tabs, back/forward history, reload/stop, an address/search bar, website popups as new tabs, downloads with a save dialog, and opening a page in your default browser. Tabs and cookies persist between launches in a separate browser session. Use **Documents** or select a file to return to the document viewer. Remote pages run without Node.js or the app's IPC preload. Website media, notification, geolocation, and other permission requests are currently denied; enter passwords and select upload files directly in the page.

Think can use `browser_tabs`, `browser_open`, `browser_navigate`, `browser_read`, and `browser_act`. The same tools support explicitly shared external browser tabs. Reading returns bounded page text and visible controls with CSS selectors; actions support clicking, filling text, selecting options, and scrolling. Password values are redacted and password/file fields cannot be filled by tools. DOM access is limited to the top frame: browser-internal pages, cross-origin frames, canvas-only controls, and native desktop interfaces need separate adapters. Some websites may reject Electron's browser or synthetic clicks.

To connect Chrome, Chromium, Edge, Brave, or Firefox:

1. In the app, choose **Browser → Extensions → Export extensions…** and select a destination. The build also creates ready-to-load folders at `dist/extensions/chromium` and `dist/extensions/firefox` (`npm run extensions` refreshes them).
2. Chromium browsers: open their extensions page (e.g. `chrome://extensions`), enable Developer mode, choose **Load unpacked**, and select the Chromium extension folder.
3. Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the Firefox folder's `manifest.json`. Temporary extensions are removed at restart. Permanent Firefox distribution requires signing through Mozilla; Chrome/Edge store distribution requires publishing separately.
4. In the desktop app, choose **Show pairing details**. Open the extension popup and paste the endpoint and pairing key into **Pair with the desktop app**. Click **Pair**. Keep the pairing key private.
5. Visit the web app you want to use and choose **Share current tab** in the extension. Ask Think to inspect or interact with that shared tab. The extension badge counts shared tabs. **Stop sharing current tab** immediately removes access for future commands.

To import cookies, pair the source Chrome/Chromium or Firefox profile as above. In its extension popup, click **Enable cookie import** and accept the browser's optional cookie/site permissions. In the desktop app, choose **Browser → Import cookies**, then **Import cookies** beside the connected source. Cookie values transfer in bounded local batches into the embedded browser session; only imported/skipped/failed counts reach the UI. Reload open tabs afterward. Matching cookies are overwritten. Cookie values never enter chat or Think/voice context. Disable cookie import in the extension popup to revoke its cookie/site permission.

Import uses the source profile's default, non-private cookie store and retains host/domain scope, path, HTTP-only/secure/SameSite flags, expiration, and session status. It skips partitioned cookies, Firefox containers/first-party isolated cookies, expired/invalid entries, and entries beyond 20,000 per import. Session cookies remain session cookies. Site storage and passwords are not imported; some sites bind sessions to a device or require additional storage and may still need a sign-in. This avoids reading encrypted browser databases or accessing system keychains.

The bridge binds only to `127.0.0.1`, using port `48765` or an available local port when that port is occupied. Copy the endpoint displayed by the app. It requires a 256-bit pairing key and rejects ordinary website origins. No web-page script can call its app IPC. The extension uses `activeTab` access, exposes only shared tabs, excludes private/incognito tabs, and revokes sharing on an origin change or tab closure. In-flight actions may already have happened when sharing is revoked; read the page before retrying a timed-out operation. The app's **Disconnect** revokes that browser origin until the pairing key is reset. **Reset pairing key** disconnects all browsers and requires them to pair again. Reconnect is automatic after normal app restarts, but never restores a tab's access across a browser restart.

Shared page content is sent to the signed-in Think backend when a browser read is requested, just as document content is sent when read. Tab titles and URLs are provided as quiet voice context. Pairing keys remain outside model context and browser pages. Think is instructed to follow the current user request, treat page content as untrusted data, and obtain explicit authorization for consequential submissions. These instructions are model policy, not a per-click application approval gate.

Verification: `npm test` covers URL/action validation and real local WebSocket authentication, routing, disconnect, and key rotation. After `npm run build`, run `npm run test:browser` for a separate real Electron/Chromium smoke test using a temporary profile and local fixture page. This verifies batched cookie imports (including HTTP-only cookies and session isolation), navigation, page snapshots, fill/select/click, redaction, history, view visibility, and tab cleanup. Run `npm run test:browser:ui` for the production renderer/preload, browser controls, and cookie import panel. These tests do not install an extension into your personal browser. The optional `npm run test:extensions` test requires Playwright and its Chromium runtime (or `PLAYWRIGHT_MODULE` pointing to an existing Playwright module). It loads a copy of the extension in a temporary profile and verifies actual pairing, cookie batches, page actions, unsharing, and revocation. This automated test grants the optional cookie permissions at installation time in the temporary copy; accepting permission prompts through the normal popup still requires an interactive browser. Firefox worker behavior is covered by API fixture tests and Mozilla extension linting; a live Firefox install has not been tested.

Implementation references: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Chrome extension WebSocket lifecycle](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets), [Firefox scripting API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript), [Firefox signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
