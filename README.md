<div align="center">
  <img src="icons/icon@2x.png" width="96" alt="ClipAI icon" /><br/>
  <h1>ClipAI</h1>
  <p><em>Instant AI summaries & explanations for any selected text.</em></p>
  <strong>Status:</strong> Public Beta
	<br/>
	<!-- Badges -->
	<p>
		<a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
		<img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20|%20Windows%20|%20Linux-informational">
		<img alt="Electron" src="https://img.shields.io/badge/electron-29.x-47848F?logo=electron&logoColor=white">
	</p>
</div>

---

## Why ClipAI?
Reading something dense and just want the gist – fast? ClipAI pops up exactly where you are, processes the current selection, and disappears when you’re done. No copy/paste dance. No browser switching. Low friction = you actually use it.

## Core Features
* Multi‑provider: OpenAI, Gemini, Anthropic, Mistral, Groq, Cohere (bring your own keys).
* One hotkey -> popup -> summary (or explanation). Hit again to dismiss.
* Smart prompt presets + custom instructions per mode.
* Fast inline markdown (bullets, bold, code).
* Themes: Dark, Light, Midnight, Forest, Rose, Amber, High Contrast.
* Aggressive memory mode destroys the window when hidden (ultra‑lean).
* Keys stored locally in `userData/config.json` only – never proxied.

## Quick Start
1. Install dependencies:
	```bash
	npm install
	```
2. Run the app:
	```bash
	npm run dev
	```
3. Press the default hotkey (macOS: `Cmd+Shift+Space`, Win/Linux: `Ctrl+Shift+Space`).
4. Paste or select text in any app, hit the hotkey, get a summary. Switch to “Explain” by assigning a second hotkey in Settings.

## Settings Overview
Open the popup and click the gear (⚙) or assign a hotkey.

Section | What it does
------- | -------------
Provider & Key | Choose an AI provider and save your API key (optional model override).
Theme & Memory | Pick a theme; set memory mode (normal vs aggressive window destruction).
Markdown | Toggle markdown rendering if you want absolute minimal CPU.
Hotkeys | Re‑record summarize/explain shortcuts (must include a non‑modifier key).
Prompt Presets | Pick terse, structured system prompts or write your own.

## Custom Prompts
Prompts act as the model’s system instructions. Keep them short and imperative. Example (summary):
```
Return 3 * terse bullets capturing problem, approach, outcome. <=12 words each. No intro.
```

## Config File
A sample lives in `config.example.json`. The runtime config is written to your OS user data dir (`app.getPath('userData')`), not the repo. Safe to delete – it will regenerate.

## Build / Distribute
Standard electron-builder config is included.
```bash
npm run build        # cross‑platform artifacts (mac/win/linux where supported)
npm run dist         # mac only convenience
```
Outputs land in `dist/`.

## Privacy & Security
* No telemetry.
* Your API keys never leave your machine except in direct HTTPS requests to the chosen provider.
* No analytics, no hidden network calls.

## Roadmap (Short List)
* Optional streaming responses.
* History panel.
* User‑defined theme editor.

## Contributing
Lightweight project – feel free to open Issues / PRs. Keep diffs focused; avoid large formatting churn.

## License
MIT (see `LICENSE`). Icons & names are provided as‑is.

---
Enjoy the flow. Ship faster. Read deeper.
