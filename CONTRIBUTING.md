# Contributing to Omni 🚀

Thank you for your interest in contributing to **Omni**!

## 🛠️ Development Setup

1. **Prerequisites**:
   - Node.js (v18+) & `npm`
   - Rust toolchain (`cargo`, `rustc`)

2. **Clone & Install**:
   ```bash
   git clone https://github.com/connortessaro/omni.git
   cd omni
   npm install
   ```

3. **Run Dev Mode**:
   ```bash
   npm run tauri dev
   ```

4. **Verify Typecheck & Backend**:
   ```bash
   npx tsc --noEmit
   cd src-tauri && cargo check
   ```

## 🤝 Contribution Guidelines

- **Pull Requests**: Open a PR against the `main` branch with a clear description of the feature or fix.
- **Code Style**: Ensure TypeScript code passes `npx tsc --noEmit` and Rust code compiles cleanly without warnings.
- **Privacy First**: Omni is strictly offline/local-first and privacy-focused. Do not add telemetry or tracking scripts.

## 📄 License

By contributing to Omni, you agree that your contributions will be licensed under the [MIT License](LICENSE).
