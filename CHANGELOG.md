# Changelog
## [1.0.0] - 2025-08-21
### Changed
- Polished UI and user experience for release.
### Fixed
- Minor bugs and edge cases resolved for stable release.

## [0.2.0] - 2025-08-21
### Added
- Onboarding Quick Setup: pick Provider/Model and enter API key.
- Settings: Danger Zone to reset all settings to defaults.
- Settings gear now toggles window; Settings opens near the cursor.
- Popup notice when no API key is configured (guides user to Preferences).
- Auto-hide timer with subtle countdown.
- Application Edit menu (Undo/Redo/Cut/Copy/Paste...) to enable clipboard in inputs.

### Changed
- Default provider set to Gemini; default model to `gemini-2.5-flash-lite`.
- Default theme set to Light.
- Default summary preset updated: ≤3 sentences with Markdown formatting.
- Window resizing restricted to custom resize handle; OS-level resize disabled.
- Markdown pipeline simplified (math/KaTeX removed); modes: Off, Light, Full.

### Fixed
- Prevented unwanted automatic window resize from content updates.
- Enabled copy/paste in Settings and onboarding fields via Edit menu.

## [0.1.0] - 2025-08-20
### Added
- Initial public beta release.
- Multi‑provider support (OpenAI, Gemini, Anthropic, Mistral, Groq, Cohere).
- Summary & Explain modes with prompt presets + custom prompts.
- Inline markdown pre-pass + async full markdown & KaTeX rendering.
- Multiple themes (dark, light, midnight, forest, rose, amber, contrast).
- Configurable hotkeys & memory mode (normal/aggressive).
- Window jitter mitigation & refined shadow / rounded styling.
- README, MIT license, and packaging configuration.

### Changed
- Improved bubble UI styling and simplified layers.

### Fixed
- Corrected plain text-only rendering by adding formatting pipeline.

---

