# Attribution

Omni is a fork of [Pluely](https://github.com/iamsrikanthnani/pluely) by
Srikanth Nani <mail@srikanthnani.com>.

Pluely is licensed under the GNU General Public License v3.0. Omni is a derivative
work and is distributed under the same license. See [LICENSE](LICENSE) for the full
text, which retains the upstream copyright notice.

## License history

This fork briefly carried an Apache-2.0 license header. That was an error: GPL-3.0 is
copyleft, and only the copyright holder can relicense the work. The GPL-3.0 license
has been restored, and every release from this point forward is GPL-3.0-only.

If you obtained a build of Omni under the incorrect Apache-2.0 notice, the terms that
actually govern that code are GPL-3.0.

## Modifications

Changes made in this fork relative to upstream Pluely:

- HUD overlay reworked, including verdict-first answers for timed assessments
- System audio capture via a CoreAudio tap
- Provider key storage moved out of `localStorage` into the secrets layer
- Speech-to-text through Gemini
- Local Ollama auto-discovery at `http://127.0.0.1:11434`
- macOS local signing with a stable identity so permission grants survive rebuilds
- Rust security audit wired into CI, with the existing advisory backlog cleared
- Slash command set expanded (`/solve`, `/answer`, `/fix`, `/commit`, `/refactor`,
  `/explain`, `/code`, `/summarize`, `/translate`, `/regex`, `/clear`)

## Source

Corresponding source for Omni is available at
<https://github.com/connortessaro/omni>, as GPL-3.0 requires.
