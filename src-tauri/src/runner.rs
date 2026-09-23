//! Runs a candidate solution against its tests, locally, before the user transcribes it.
//!
//! An assessment answer is worth nothing if it fails the question's own test cases, and
//! the reader has minutes to find that out. This writes the answer's files to a scratch
//! directory, runs one command over them, and reports what happened.
//!
//! What this is not: a sandbox. The child runs as the user, with the user's filesystem
//! and network, because there is no portable jail available here and pretending otherwise
//! would be worse than saying so. What it does have is a wall-clock timeout, an output
//! cap, an interpreter allowlist, a scratch directory that is removed afterwards, and
//! paths that cannot escape that directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Long enough for a test suite that imports numpy, short enough that an accidental
/// infinite loop does not hold the HUD.
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// Beyond this the output is noise the panel cannot show anyway, and a runaway `print`
/// in a loop would otherwise fill memory before the timeout fires.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Only interpreters, and only ones named here. The language is chosen by the frontend
/// from the answer's own code fences, so an allowlist is what keeps a crafted answer from
/// naming `bash` or an absolute path to something else.
fn interpreter_for(language: &str) -> Option<(&'static str, &'static [&'static str])> {
    match language.to_ascii_lowercase().as_str() {
        "python" | "python3" | "py" => Some(("python3", &[])),
        "javascript" | "js" | "node" => Some(("node", &[])),
        "typescript" | "ts" => Some(("node", &["--experimental-strip-types"])),
        _ => None,
    }
}

/// Where interpreters live when the app was not launched from a shell.
///
/// A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, so
/// `node` installed by Homebrew or nvm and `python3` installed by Homebrew are all
/// invisible to it even though they work in every terminal on the machine. Searching
/// these explicitly is what keeps "Run tests" from reporting that node is not installed
/// on a machine that plainly has it.
const EXTRA_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/// nvm keeps each version in its own directory and puts none of them on a global PATH.
fn nvm_node_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let versions = PathBuf::from(home).join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return Vec::new();
    };

    // Newest first. Sorting the names as strings puts v9 above v10, so the version is
    // compared as numbers.
    let mut found: Vec<(Vec<u64>, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let parts = name
                .trim_start_matches('v')
                .split('.')
                .map(|part| part.parse::<u64>().unwrap_or(0))
                .collect::<Vec<_>>();
            (parts, entry.path().join("bin"))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// Every directory worth looking in, the given PATH first so a shell-launched app keeps
/// using whatever the user's shell would have used.
///
/// PATH is a parameter rather than an environment read so the Finder case (no useful
/// PATH at all) is testable without mutating the environment other tests are running in.
fn search_dirs(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    dirs.extend(EXTRA_BIN_DIRS.iter().map(PathBuf::from));
    dirs.extend(nvm_node_dirs());
    dirs
}

/// Resolves an interpreter to an absolute path, so the child is spawned against a binary
/// that was confirmed to exist rather than against a name and a hope.
fn resolve_program(program: &str) -> Option<PathBuf> {
    resolve_program_in(program, std::env::var_os("PATH").as_deref())
}

fn resolve_program_in(program: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
    search_dirs(path_var).into_iter().find_map(|dir| {
        let candidate = dir.join(program);
        candidate.is_file().then_some(candidate)
    })
}

#[derive(Debug, Deserialize)]
pub struct RunFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    /// True when the child was killed at the deadline rather than exiting on its own.
    pub timed_out: bool,
    /// True when either stream hit the cap and the rest was discarded.
    pub truncated: bool,
    pub duration_ms: u64,
    /// The interpreter that ran, so the panel can say "python3" rather than "the runner".
    pub command: String,
}

/// Rejects anything that would write outside the scratch directory: an absolute path, a
/// `..` hop, a root or prefix component. Returns the path joined onto `root`.
fn safe_join(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    let relative = Path::new(candidate);
    if relative.as_os_str().is_empty() {
        return Err("a file in the answer has an empty path".into());
    }

    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("path escapes the run directory: {candidate}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("path must be relative: {candidate}"))
            }
        }
    }

    Ok(root.join(relative))
}

/// Reads at most `MAX_OUTPUT_BYTES`, reporting whether anything was left behind.
fn read_capped(mut stream: impl Read) -> (String, bool) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(buffer.len());
                if room == 0 {
                    // Keep draining so the child is never blocked on a full pipe, which
                    // would deadlock it against the timeout instead of letting it exit.
                    continue;
                }
                buffer.extend_from_slice(&chunk[..n.min(room)]);
            }
            Err(_) => break,
        }
    }

    let truncated = buffer.len() >= MAX_OUTPUT_BYTES;
    (String::from_utf8_lossy(&buffer).into_owned(), truncated)
}

/// Writes `files` into a scratch directory and runs `entry` with the interpreter for
/// `language`. The directory is removed before returning, on every path out.
#[tauri::command]
pub async fn run_code(
    language: String,
    files: Vec<RunFile>,
    entry: String,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    tokio::task::spawn_blocking(move || {
        let (program, extra_args) = interpreter_for(&language)
            .ok_or_else(|| format!("no runner for `{language}`. Supported: python, javascript, typescript"))?;

        if files.is_empty() {
            return Err("nothing to run: the answer contained no code files".into());
        }
        if !files.iter().any(|file| file.path == entry) {
            return Err(format!("entry `{entry}` is not one of the files to run"));
        }

        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));

        let root = std::env::temp_dir().join(format!("omni-run-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create run directory: {e}"))?;

        let outcome = run_in(&root, program, extra_args, &files, &entry, timeout);

        // Best effort: a failure to clean up is not worth failing a run the user is waiting
        // on, and the directory is under the OS temp root either way.
        let _ = std::fs::remove_dir_all(&root);

        outcome
    })
    .await
    .map_err(|e| format!("Runner task joined with error: {e}"))?
}

fn run_in(
    root: &Path,
    program: &str,
    extra_args: &[&str],
    files: &[RunFile],
    entry: &str,
    timeout: Duration,
) -> Result<RunResult, String> {
    for file in files {
        let target = safe_join(root, &file.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        std::fs::write(&target, &file.content)
            .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;
    }

    let started = Instant::now();

    // The environment is replaced rather than inherited: the app's own process carries
    // provider configuration, and a test file is model-written code that should not be
    // able to read it. PATH stays because the interpreter needs to find its own tools.
    let mut env: HashMap<String, String> = HashMap::new();
    if let Ok(path) = std::env::var("PATH") {
        env.insert("PATH".into(), path);
    }
    env.insert("HOME".into(), root.display().to_string());
    // Unbuffered, so a suite that times out still shows what it printed before it hung.
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("PYTHONDONTWRITEBYTECODE".into(), "1".into());
    env.insert("NO_COLOR".into(), "1".into());

    let resolved = resolve_program(program).ok_or_else(|| {
        format!(
            "`{program}` was not found. Looked on PATH and in {}.",
            EXTRA_BIN_DIRS.join(", ")
        )
    })?;

    // The resolved directory joins the child's PATH so the interpreter can find its own
    // neighbours: node resolving npx, python3 resolving pip's console scripts.
    if let Some(parent) = resolved.parent() {
        let existing = env.get("PATH").cloned().unwrap_or_default();
        env.insert(
            "PATH".into(),
            format!("{}:{existing}", parent.display()),
        );
    }

    let mut child = Command::new(&resolved)
        .args(extra_args)
        .arg(entry)
        .current_dir(root)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("`{program}` is not installed or not on PATH")
            } else {
                format!("Failed to start `{}`: {e}", resolved.display())
            }
        })?;

    // Drained on threads so a child that fills one pipe cannot block while the other is
    // being read, which would look like a hang and be reported as a timeout.
    let stdout = child.stdout.take().map(|s| std::thread::spawn(move || read_capped(s)));
    let stderr = child.stderr.take().map(|s| std::thread::spawn(move || read_capped(s)));

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    timed_out = true;
                    break child.wait().map_err(|e| format!("Failed to reap child: {e}"))?;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("Failed to wait on child: {e}")),
        }
    };

    let (out, out_truncated) = stdout.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let (err, err_truncated) = stderr.map(|h| h.join().unwrap_or_default()).unwrap_or_default();

    Ok(RunResult {
        // A killed process reports no code of its own; -1 says "did not finish" without
        // colliding with a real exit status.
        exit_code: status.code().unwrap_or(-1),
        stdout: out,
        stderr: err,
        timed_out,
        truncated: out_truncated || err_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        command: program.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, content: &str) -> RunFile {
        RunFile {
            path: path.into(),
            content: content.into(),
        }
    }

    fn run(files: Vec<RunFile>, entry: &str, timeout_ms: u64) -> Result<RunResult, String> {
        let root = std::env::temp_dir().join(format!("omni-run-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result = run_in(
            &root,
            "python3",
            &[],
            &files,
            entry,
            Duration::from_millis(timeout_ms),
        );
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn a_passing_suite_exits_zero() {
        let result = run(
            vec![
                file("solution.py", "def add(a, b):\n    return a + b\n"),
                file(
                    "test_solution.py",
                    "from solution import add\nassert add(2, 2) == 4\nprint('2 passed')\n",
                ),
            ],
            "test_solution.py",
            10_000,
        )
        .unwrap();

        assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
        assert!(result.stdout.contains("2 passed"));
        assert!(!result.timed_out);
    }

    #[test]
    fn a_failing_assertion_comes_back_with_its_message() {
        let result = run(
            vec![file("test_solution.py", "assert 1 == 2, 'off by one'\n")],
            "test_solution.py",
            10_000,
        )
        .unwrap();

        assert_ne!(result.exit_code, 0);
        assert!(
            result.stderr.contains("off by one"),
            "stderr was: {}",
            result.stderr
        );
    }

    #[test]
    fn an_infinite_loop_is_killed_at_the_deadline() {
        let result = run(
            vec![file("test_solution.py", "while True:\n    pass\n")],
            "test_solution.py",
            600,
        )
        .unwrap();

        assert!(result.timed_out, "a spinning child must be killed");
        assert!(result.duration_ms < 5_000, "took {}ms", result.duration_ms);
    }

    #[test]
    fn output_is_capped_rather_than_unbounded() {
        let result = run(
            vec![file(
                "test_solution.py",
                "for _ in range(200000):\n    print('x' * 80)\n",
            )],
            "test_solution.py",
            20_000,
        )
        .unwrap();

        assert!(result.truncated, "a flood of output must be reported as capped");
        assert!(result.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn a_path_cannot_escape_the_run_directory() {
        let root = Path::new("/tmp/omni-run-example");
        assert!(safe_join(root, "../../etc/passwd").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "").is_err());
        assert_eq!(
            safe_join(root, "tests/test_a.py").unwrap(),
            root.join("tests/test_a.py")
        );
    }

    #[test]
    fn an_interpreter_resolves_with_the_path_a_finder_launch_gets() {
        // A Finder-launched app inherits no useful PATH. Both interpreters still have to
        // be found, or "Run tests" reports node missing on a machine that has three
        // copies of it.
        assert!(
            resolve_program_in("python3", None).is_some(),
            "python3 must resolve without a shell PATH"
        );
        assert!(
            resolve_program_in("node", None).is_some(),
            "node must resolve without a shell PATH"
        );
    }

    #[test]
    fn a_program_that_is_not_installed_resolves_to_nothing() {
        assert!(resolve_program_in("definitely-not-an-interpreter", None).is_none());
    }

    #[test]
    fn only_interpreters_on_the_allowlist_can_run() {
        assert!(interpreter_for("python").is_some());
        assert!(interpreter_for("JavaScript").is_some());
        assert!(interpreter_for("bash").is_none());
        assert!(interpreter_for("sh").is_none());
        assert!(interpreter_for("ruby").is_none());
    }

    #[test]
    fn the_child_cannot_read_the_apps_environment() {
        std::env::set_var("OMNI_TEST_LEAKED_SECRET", "should-not-be-visible");
        let result = run(
            vec![file(
                "test_solution.py",
                "import os\nprint(os.environ.get('OMNI_TEST_LEAKED_SECRET', 'absent'))\n",
            )],
            "test_solution.py",
            10_000,
        )
        .unwrap();

        assert!(
            result.stdout.contains("absent"),
            "the app environment leaked into the child: {}",
            result.stdout
        );
    }
}
