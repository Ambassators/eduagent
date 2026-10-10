# Third-party dependencies

GlassTeX's first-party source is MIT-licensed. The editor, command catalogue, and pinned rendering dependencies are bundled locally in this application. No download is required to edit or export documents.

| Component | Pinned version | Role | License |
| --- | --- | --- | --- |
| MathLive | 0.109.2 | Structural math input | MIT |
| KaTeX | 0.16.22 | Static TeX-style preview | MIT |

The build copies the original package license files into the dependency directories in the app's resources. Their bundled typesetting assets remain subject to the respective upstream notices. Do not remove those notices when redistributing a built app.

The Electron adapter uses the original GlassTeX parser, editor, local solver, and selection implementation. A small MathLive 0.109.2 lifecycle patch checks `it(r)` before blurring the previous globally focused field in `onFocus`. This prevents accessing a disposed model when undo or a source update replaces fields during MathLive's asynchronous focus transition. All other vendor code and original license files are preserved.

Upstream projects:
- MathLive: https://github.com/arnog/mathlive
- MathLive documentation: https://mathlive.io/mathfield/
- KaTeX: https://github.com/KaTeX/KaTeX
- KaTeX documentation: https://katex.org/docs/api.html

GlassTeX is not affiliated with Desmos or Apple. It uses neither Desmos code nor Apple's private math-solving APIs. Its bounded local solver is first-party JavaScript and is not a full computer algebra system.
