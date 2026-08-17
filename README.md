# Omni 🚀

_Fast, stealthy AI desktop companion built for developers and power users._

<p align="center">
  <b>Omni</b> is an intelligent, distraction-free desktop overlay that brings AI capabilities to your fingertips with zero context switching.
</p>

---

## ✨ Features

- **⚡ Instant Overlay**: Access Omni anywhere on macOS via global shortcuts (`⌘ + \` or custom hotkey).
- **🪄 Instant Slash Commands**:
  - `/fix <text>`: Polish grammar, spelling, and tone.
  - `/explain <topic>`: Simplify complex topics with examples.
  - `/code <prompt>`: Generate production-ready code with explanations.
  - `/summarize <text>`: Condense text into concise bullet points.
  - `/regex <pattern>`: Build or explain regular expressions.
  - `/clear`: Wipe active conversation and reset context.
- **⌨️ Prompt History (`↑` / `↓`)**: Cycle through previous queries seamlessly from your keyboard.
- **⚡ 1-Click Local Ollama Detection**: Auto-discover and connect to local Ollama models (`http://localhost:11434`) without typing model strings.
- **📸 Screen & Region Capture**: Screenshot selected desktop areas and ask questions with multimodal vision models.
- **🔓 100% Unlocked & Private**: Runs locally on your machine with direct API connections (OpenAI, Anthropic, Gemini, Groq, Mistral, Ollama) and zero third-party telemetry.
- **💬 Full Chat History & SQLite Storage**: All conversations and system prompt presets persist safely in local SQLite storage.

---

## 🛠️ Development & Building

### Prerequisites
- Node.js (v18+) & `npm`
- Rust toolchain (`cargo`, `rustc`)

### Quickstart

```bash
# Install frontend dependencies
npm install

# Run in development mode (hot reload)
npm run tauri dev

# Build the macOS release app bundle (.app and .dmg)
npm run tauri build
```

The compiled application bundle will be created at:
`src-tauri/target/release/bundle/macos/Omni.app`

---

## 📄 License

GPL-3.0 License
