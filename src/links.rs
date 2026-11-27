//! Links in terminal text: Ghostty's URL and file path pattern, what a match
//! points to, and opening URLs or locating files on the source machine.

use fancy_regex::Regex;
use std::borrow::Cow;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Ghostty's default link pattern (`src/config/url.zig`), unchanged.
static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let schemes = r"https?://|mailto:|ftp://|file:|ssh:|git://|ssh://|tel:|magnet:|ipfs://|ipns://|gemini://|gopher://|news:";
    let ipv6 = r"(?:\[[:0-9a-fA-F]+(?:[:0-9a-fA-F]*)+\](?::[0-9]+)?)";
    let scheme_chars = r"[\w\-.~:/?#@!$&*+,;=%]";
    let path_chars = r"[\w\-.~:\/?#@!$&*+;=%]";
    let bracketed = r"(?:[\(\[]\w*[\)\]])?";
    let no_trailing_punctuation = r"(?<![,.])";
    let no_trailing_colon = r"(?<!:)";
    let dotted = r"(?=[\w\-.~:\/?#@!$&*+;=%]*\.)";
    let undotted = r"(?![\w\-.~:\/?#@!$&*+;=%]*\.)";
    let dotted_spaces = r"(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)[\w\-.~:\/?#@!$&*+;=%]*[\/.])*";
    let any_spaces = r"(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)[\w\-.~:\/?#@!$&*+;=%]+)*";
    let rooted = r"(?:\.\.\/|\.\/|(?<!\w)~\/|(?:[\w][\w\-.]*\/)*(?<!\w)\$[A-Za-z_]\w*\/|\.[\w][\w\-.]*\/|(?<![\w~\/])\/(?!\/))";
    let scheme_url = format!("(?:{schemes})(?:{ipv6}|{scheme_chars}+{bracketed})+{no_trailing_punctuation}");
    let rooted_path = format!(
        "{rooted}(?:{dotted}{path_chars}+{dotted_spaces}{no_trailing_colon}|{undotted}{path_chars}+{any_spaces}{no_trailing_colon})"
    );
    let bare_path = format!(r"{dotted}(?<!\$\d*)(?<!\w)[\w][\w\-.]*\/{path_chars}+{no_trailing_colon}");
    Regex::new(&format!("{scheme_url}|{rooted_path}|{bare_path}")).expect("link pattern")
});

/// The link in `text` that covers byte `at`.
pub fn find(text: &str, at: usize) -> Option<Range<usize>> {
    for m in PATTERN.find_iter(text) {
        let m = m.ok()?;
        if m.start() > at {
            return None;
        }
        if at < m.end() {
            return Some(m.range());
        }
    }
    None
}

/// The address-shaped word under the pointer, excluding surrounding punctuation.
pub fn word(text: &str, at: usize) -> Option<Range<usize>> {
    let allowed = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.');
    if !text.get(at..)?.chars().next().is_some_and(allowed) {
        return None;
    }
    let start = text[..at].char_indices().rev().find(|(_, c)| !allowed(*c)).map_or(0, |(i, c)| i + c.len_utf8());
    let end = text[at..].char_indices().find(|(_, c)| !allowed(*c)).map_or(text.len(), |(i, _)| at + i);
    let trimmed = text[start..end].trim_matches('.');
    let start = start + text[start..end].len() - text[start..end].trim_start_matches('.').len();
    let end = start + trimmed.len();
    (start <= at && at < end).then_some(start..end)
}

/// Bare addresses refer to the hovered terminal's machine, never its names.
pub fn terminal_address<'a>(word: &str, source: &str, live: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let address = if word.contains('/') {
        word.to_owned()
    } else {
        crate::mirror::qualify(word, source.split_once('/').map(|(machine, _)| machine))
    };
    live.into_iter().any(|a| a == address).then_some(address)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Url(String),
    File(PathBuf),
}

/// What a link opens in a local terminal. Remote paths are checked on click.
#[cfg(test)]
fn resolve(link: &str, cwd: Option<&Path>) -> Option<Target> {
    resolve_on(link, cwd, false)
}

pub fn is_uri(link: &str) -> bool {
    link.split_once(':').is_some_and(|(scheme, rest)| {
        matches!(scheme.to_ascii_lowercase().as_str(), "file" | "mailto" | "ssh" | "tel" | "magnet" | "news")
            || (rest.starts_with("//")
                && scheme.len() > 1
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)))
    })
}

pub fn resolve_on(link: &str, cwd: Option<&Path>, remote: bool) -> Option<Target> {
    let uri = link.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"));
    if !uri && is_uri(link) {
        return Some(Target::Url(link.to_owned()));
    }
    let link = if uri { Cow::Owned(file_uri_path(&link[5..])?) } else { Cow::Borrowed(link) };
    if remote {
        return Some(Target::File(PathBuf::from(link.as_ref())));
    }
    candidates(&link).into_iter().find_map(|link| local_path(link, cwd).map(Target::File))
}

fn file_uri_path(uri: &str) -> Option<String> {
    // The source terminal determines the machine. A URI authority never
    // opens another machine or becomes a network share on the desktop.
    let path = match uri.strip_prefix("//") {
        Some(authority) => &authority[authority.find('/')?..],
        None => uri,
    };
    let path = path.split(['?', '#']).next()?.strip_prefix('/')?;
    let mut decoded = vec![b'/'];
    let mut bytes = path.as_bytes().iter().copied();
    while let Some(b) = bytes.next() {
        let b = if b == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            (high * 16 + low) as u8
        } else { b };
        if b == 0 { return None; }
        decoded.push(b);
    }
    // Drive-letter file URIs spell the root /C:/ even on a POSIX desktop.
    if decoded.get(1).is_some_and(u8::is_ascii_alphabetic) && decoded.get(2..4) == Some(b":/") {
        decoded.remove(0);
    }
    String::from_utf8(decoded).ok()
}

fn local_path(link: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let home = std::env::home_dir();
    let expanded = if let Some(rest) = link.strip_prefix("~/") {
        home?.join(rest)
    } else if let Some(var) = link.strip_prefix('$') {
        let (name, rest) = var.split_once('/').unwrap_or((var, ""));
        let base = match name {
            "PWD" => cwd?.to_path_buf(),
            "HOME" => home?,
            _ => PathBuf::from(std::env::var_os(name)?),
        };
        base.join(rest)
    } else {
        PathBuf::from(link)
    };
    let full = if expanded.is_absolute() { expanded } else { cwd?.join(expanded) };
    // Windows ignores trailing periods in its filesystem lookup.
    if cfg!(windows) && full.extension().is_some_and(|ext| ext.is_empty()) { return None; }
    std::fs::metadata(&full).is_ok_and(|m| m.is_file() || m.is_dir()).then_some(full)
}

/// Prefer a literal path (including spaces or a numeric suffix). When that
/// misses, drop common Agent line references and trailing prose.
fn candidates(word: &str) -> Vec<&str> {
    let mut out = vec![word];
    let mut text = word.trim_end();
    for _ in 0..8 {
        let mut suffix = text;
        for _ in 0..4 {
            if !suffix.is_empty() && !out.contains(&suffix) { out.push(suffix); }
            if let Some(bare) = suffix.strip_suffix('.').filter(|s| !s.ends_with('/') && !s.ends_with('.')) {
                suffix = bare;
            } else if let Some((bare, _)) = suffix.rsplit_once(':').filter(|(_, s)| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
                suffix = bare;
            } else { break; }
        }
        let Some((left, _)) = text.rsplit_once(' ') else { break };
        text = left.trim_end();
    }
    out
}

/// A file to preview, or the directory to show in Files.
#[derive(Debug, PartialEq)]
pub struct Location {
    pub folder: String,
    pub file: Option<String>,
    pub path: String,
}

pub fn open_path(path: &Path, cwd: Option<&Path>, machine: Option<&str>) -> Result<Location, String> {
    let path = path.to_str().ok_or("Path is not UTF-8")?;
    if let Some(machine) = machine {
        return remote_path(path, cwd.and_then(Path::to_str), machine);
    }
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let full = path.to_str().ok_or("Path is not UTF-8")?.to_owned();
    if meta.is_dir() {
        return Ok(Location { folder: full.clone(), file: None, path: full });
    }
    if !meta.is_file() { return Err("Path does not name a file or directory".into()); }
    let folder = path.parent().and_then(Path::to_str).ok_or("File has no parent directory")?.to_owned();
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("File has no name")?.to_owned();
    Ok(Location { folder, file: Some(name), path: full })
}

const POSIX_PATH_CHECK: &str = r#"
base=$1; shift
unset CDPATH
for path do
  case "$path" in
    /*) full=$path ;;
    '~'|'$HOME') full=$HOME ;;
    '~/'*|'$HOME/'*) full=$HOME/${path#*/} ;;
    '$PWD') full=$base ;;
    *) [ -n "$base" ] || continue
       full=${base%/}/${path#\$PWD/} ;;
  esac
  if [ -d "$full" ]; then
    cd -P "$full" && printf 'd\0%s\0\0%s' "$PWD" "$PWD"
    exit
  fi
  if [ -f "$full" ]; then
    cd -P "${full%/*}/" && printf 'f\0%s\0%s\0%s' "$PWD" "${full##*/}" "${PWD%/}/${full##*/}"
    exit
  fi
done
exit 1
"#;

fn remote_path(path: &str, cwd: Option<&str>, machine: &str) -> Result<Location, String> {
    use crate::mods::run_remote_with_limit;
    let limit = std::time::Duration::from_secs(8);
    let base = cwd.unwrap_or_default();
    let paths = candidates(path);
    let args = ["-c", POSIX_PATH_CHECK, "herdr-path", base].into_iter().chain(paths.iter().copied()).map(str::to_owned).collect::<Vec<_>>();
    let (code, out, _) = match run_remote_with_limit(machine, "sh", &args, None, limit) {
        Err(error) if error.contains("cannot start sh: program not found") => {
            let mut script = String::from(r#"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
& { param($base)
    foreach ($path in $args) {
        if ($path -eq '~' -or $path -eq '$HOME') { $path = $HOME }
        elseif ($path.StartsWith('~/') -or $path.StartsWith('~\') -or $path.StartsWith('$HOME/')) {
            $path = [IO.Path]::Combine($HOME, $path.Substring($path.IndexOfAny('/\'.ToCharArray()) + 1))
        }
        elseif (-not [IO.Path]::IsPathRooted($path)) {
            if (-not $base) { continue }
            if ($path.StartsWith('$PWD/')) { $path = $path.Substring(5) }
            $path = [IO.Path]::Combine($base, $path)
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($item -is [IO.DirectoryInfo]) { $parts = @('d', $item.FullName, '', $item.FullName) }
        elseif ($item -is [IO.FileInfo] -and [IO.File]::Exists($item.FullName)) {
            $parts = @('f', $item.DirectoryName, $item.Name, $item.FullName)
        }
        else { continue }
        [Console]::Write(($parts -join [char]0))
        exit 0
    }
    exit 1
}
"#);
            // Keep script data literal, including PowerShell's curly quotes.
            for arg in std::iter::once(base).chain(paths) {
                script.push_str(" '");
                for ch in arg.chars() {
                    if matches!(ch, '\'' | '‘' | '’' | '‚' | '‛') { script.push(ch); }
                    script.push(ch);
                }
                script.push('\'');
            }
            run_remote_with_limit(machine, "powershell", &["-NoProfile".into(), "-Command".into(), script], None, limit)
        }
        result => result,
    }?;
    if code != 0 { return Err(format!("Path not found on {machine}")); }
    parse_location(out)
}

fn parse_location(out: Vec<u8>) -> Result<Location, String> {
    let text = String::from_utf8(out).map_err(|_| "Path is not UTF-8")?;
    let fields: Vec<_> = text.split('\0').collect();
    match fields.as_slice() {
        [kind @ ("d" | "f"), folder, name, path] if !folder.is_empty() && !path.is_empty() => Ok(Location {
            folder: (*folder).to_owned(), file: (*kind == "f").then(|| (*name).to_owned()), path: (*path).to_owned(),
        }),
        _ => Err("The machine returned an invalid path".into()),
    }
}

/// Hands a URL to the system's default handler.
pub fn open(url: &str) {
    open_system(std::ffi::OsStr::new(url));
}

#[cfg(windows)]
fn open_system(arg: &std::ffi::OsStr) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    let mut wide: Vec<u16> = arg.encode_wide().collect();
    if wide.contains(&0) {
        tracing::warn!("cannot open a link containing a NUL");
        return;
    }
    wide.push(0);
    // ShellExecuteW can pump messages; never reenter GPUI while it handles a click.
    std::thread::spawn(move || {
        let initialized = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
        // Explorer interprets '=' as its own arguments; the handler gets a literal target.
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), std::ptr::null(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
        } as isize;
        if result <= 32 {
            tracing::warn!("cannot open link: ShellExecuteW returned {result}");
        }
        if initialized >= 0 {
            unsafe { CoUninitialize() };
        }
    });
}

#[cfg(not(windows))]
fn open_system(arg: &std::ffi::OsStr) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let spawned = std::process::Command::new(opener)
        .arg(arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        // Reaped off the UI thread so it never lingers as a zombie.
        Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
        Err(e) => tracing::warn!("cannot run {opener}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(text: &str) -> Option<&str> {
        PATTERN.find(text).unwrap().map(|m| m.as_str())
    }

    /// Ghostty's own cases (`src/config/url.zig`).
    #[test]
    fn matches_like_ghostty() {
        let cases = [
            ("hello https://example.com world", "https://example.com"),
            ("https://example.com/foo(bar) more", "https://example.com/foo(bar)"),
            ("https://example.com/foo(bar)baz more", "https://example.com/foo(bar)baz"),
            ("Link inside (https://example.com) parens", "https://example.com"),
            ("Link period https://example.com. More text.", "https://example.com"),
            ("Link trailing comma https://example.com, more text.", "https://example.com"),
            ("Link in double quotes \"https://example.com\" and more", "https://example.com"),
            ("Link in single quotes 'https://example.com' and more", "https://example.com"),
            ("some file with https://google.com https://duckduckgo.com links.", "https://google.com"),
            ("and links in it. links https://yahoo.com mailto:test@example.com ssh://1.2.3.4", "https://yahoo.com"),
            ("also match http://example.com non-secure links", "http://example.com"),
            ("match tel://+12123456789 phone numbers", "tel://+12123456789"),
            ("match with query url https://example.com?query=1&other=2 and more text.", "https://example.com?query=1&other=2"),
            (
                "url with dashes [mode 2027](https://github.com/contour-terminal/terminal-unicode-core) for better unicode support",
                "https://github.com/contour-terminal/terminal-unicode-core",
            ),
            ("dot.http://example.com", "http://example.com"),
            ("weird characters https://example.com/~user/?query=1&other=2#hash and more", "https://example.com/~user/?query=1&other=2#hash"),
            ("square brackets https://example.com/[foo] and more", "https://example.com/[foo]"),
            (
                "[13]:TooManyStatements: TempFile#assign_temp_file_to_entity has approx 7 statements [https://example.com/docs/Too-Many-Statements.md]",
                "https://example.com/docs/Too-Many-Statements.md",
            ),
            ("match ftp://example.com ftp links", "ftp://example.com"),
            ("match file://example.com file links", "file://example.com"),
            ("match ssh://example.com ssh links", "ssh://example.com"),
            ("match git://example.com git links", "git://example.com"),
            ("/tmp/test.txt http://www.google.com", "/tmp/test.txt"),
            ("match tel:+18005551234 tel links", "tel:+18005551234"),
            ("match magnet:?xt=urn:btih:1234567890 magnet links", "magnet:?xt=urn:btih:1234567890"),
            ("match ipfs://QmSomeHashValue ipfs links", "ipfs://QmSomeHashValue"),
            ("match ipns://QmSomeHashValue ipns links", "ipns://QmSomeHashValue"),
            ("match gemini://example.com gemini links", "gemini://example.com"),
            ("match gopher://example.com gopher links", "gopher://example.com"),
            ("match news:comp.infosystems.www.servers.unix news links", "news:comp.infosystems.www.servers.unix"),
            ("/Users/ghostty.user/code/example.py", "/Users/ghostty.user/code/example.py"),
            ("/Users/ghostty.user/code/../example.py", "/Users/ghostty.user/code/../example.py"),
            ("/Users/ghostty.user/code/../example.py hello world", "/Users/ghostty.user/code/../example.py"),
            ("../example.py", "../example.py"),
            ("../example.py ", "../example.py"),
            ("first time ../example.py contributor ", "../example.py"),
            ("[link](/home/user/ghostty.user/example)", "/home/user/ghostty.user/example"),
            ("Serving HTTP on :: port 8000 (http://[::]:8000/)", "http://[::]:8000/"),
            ("IPv6 address https://[2001:db8::1]:8080/path", "https://[2001:db8::1]:8080/path"),
            ("IPv6 localhost http://[::1]:3000", "http://[::1]:3000"),
            ("Complex IPv6 https://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:443/", "https://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:443/"),
            ("IPv6 with path https://[2001:db8::1]/path/to/resource", "https://[2001:db8::1]/path/to/resource"),
            ("IPv6 with query https://[2001:db8::1]:8080/api?param=value&other=123", "https://[2001:db8::1]:8080/api?param=value&other=123"),
            ("IPv6 compressed http://[2001:db8::]:80/", "http://[2001:db8::]:80/"),
            ("IPv6 multiple zeros http://[2001:0:0:0:0:0:0:1]", "http://[2001:0:0:0:0:0:0:1]"),
            ("IPv6 link-local https://[fe80::1234:5678:9abc]", "https://[fe80::1234:5678:9abc]"),
            ("IPv6 multicast http://[ff02::1]/stream", "http://[ff02::1]/stream"),
            ("IPv6 in markdown [link](http://[2001:db8::1]/docs)", "http://[2001:db8::1]/docs"),
            ("./spaces-end.   ", "./spaces-end."),
            ("./space middle", "./space middle"),
            ("../test folder/file.txt", "../test folder/file.txt"),
            ("/tmp/test folder/file.txt", "/tmp/test folder/file.txt"),
            ("/tmp/test  folder/file.txt", "/tmp/test"),
            ("diff --git a/src/font/shaper/harfbuzz.zig b/src/font/shaper/harfbuzz.zig", "a/src/font/shaper/harfbuzz.zig"),
            ("/tmp/foo /tmp/bar", "/tmp/foo"),
            ("/tmp/foo.txt /tmp/bar.txt", "/tmp/foo.txt"),
            ("src/config/url.zig", "src/config/url.zig"),
            ("app/folder/file.rb:1", "app/folder/file.rb:1"),
            ("modified:   src/config/url.zig", "src/config/url.zig"),
            ("lib/ghostty/terminal.zig:42:10", "lib/ghostty/terminal.zig:42:10"),
            ("some-pkg/src/file.txt more text", "some-pkg/src/file.txt"),
            ("src/foo.c,baz.txt", "src/foo.c"),
            ("~/foo/bar.txt", "~/foo/bar.txt"),
            ("open ~/Documents/notes.md please", "~/Documents/notes.md"),
            ("~/.config/ghostty/config", "~/.config/ghostty/config"),
            ("directory: ~/src/ghostty-org/ghostty", "~/src/ghostty-org/ghostty"),
            ("$HOME/src/config/url.zig", "$HOME/src/config/url.zig"),
            ("space dir: $PWD/src/ghostty/main.zig", "$PWD/src/ghostty/main.zig"),
            ("foo/$BAR/baz", "foo/$BAR/baz"),
            (".foo/bar/$VAR", ".foo/bar/$VAR"),
            (".config/ghostty/config", ".config/ghostty/config"),
            ("loaded from .local/share/ghostty/state.db now", ".local/share/ghostty/state.db"),
            ("../some/where", "../some/where"),
            ("  - shared/src/foo/SomeItem.m:12, shared/src/", "shared/src/foo/SomeItem.m:12"),
            ("foo.local/share", "foo.local/share"),
            ("2024/report.txt", "2024/report.txt"),
            ("./foo bar,baz", "./foo bar"),
            ("/tmp/foo bar,baz", "/tmp/foo bar"),
            ("./.config/ghostty: Needs upstream (main)", "./.config/ghostty"),
            ("./Downloads: Operation not permitted", "./Downloads"),
        ];
        for (input, expect) in cases {
            assert_eq!(first(input), Some(expect), "{input:?}");
        }
        for input in ["input/output", "foo/bar", "$10/bar", "$10/$20", "$10/bar.txt", "foo/bar,baz.txt", "foo$BAR/baz.txt", "foo~/bar.txt", "// foo bar", "//foo"] {
            assert_eq!(first(input), None, "{input:?}");
        }
    }

    #[test]
    fn query_links_keep_their_full_target() {
        for url in ["https://example.com/?a=1&b=2", "https://localhost:17480/login?t=abc%3D%3D"] {
            let text = format!("Dashboard: {url}");
            let range = find(&text, text.find(url).unwrap()).unwrap();
            assert_eq!(&text[range.clone()], url);
            assert_eq!(resolve(&text[range], None), Some(Target::Url(url.into())));
        }
    }

    #[test]
    fn file_uris_use_the_source_machine() {
        for (link, path) in [
            ("file:///tmp/Notes%20%23%E8%B5%84%E6%96%99.md#L5", "/tmp/Notes #资料.md"),
            ("file://remote/opt/work/", "/opt/work/"),
            ("file:///C:/Work/README.md", "C:/Work/README.md"),
        ] {
            assert_eq!(resolve_on(link, None, true), Some(Target::File(path.into())));
        }
        assert_eq!(resolve_on("file:///tmp/%00", None, true), None);
        assert_eq!(resolve_on("README.md:42", None, true), Some(Target::File("README.md:42".into())));
    }

    #[test]
    #[cfg(unix)]
    fn remote_path_check_handles_directories_files_and_literal_names() {
        let cwd = std::env::temp_dir().join(format!("herdr-remote-path-check-{}", std::process::id()));
        let folder = cwd.join("Notes Folder");
        let file = folder.join("Read me $(literal).md");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&file, "").unwrap();
        let check = |link: &str| {
            let out = std::process::Command::new("sh")
                .args(["-c", POSIX_PATH_CHECK, "herdr-path", cwd.to_str().unwrap()])
                .args(candidates(link))
                .output().unwrap();
            assert!(out.status.success());
            parse_location(out.stdout).unwrap()
        };
        let actual_folder = folder.canonicalize().unwrap().to_str().unwrap().to_owned();
        assert_eq!(check("./Notes Folder"), Location { folder: actual_folder.clone(), file: None, path: actual_folder.clone() });
        assert_eq!(check("$PWD/Notes Folder/Read me $(literal).md:42:7."), Location {
            folder: actual_folder,
            file: Some("Read me $(literal).md".into()),
            path: file.canonicalize().unwrap().to_str().unwrap().into(),
        });
        std::fs::remove_dir_all(cwd).unwrap();
    }

    #[test]
    fn finds_the_link_under_the_pointer() {
        let text = "see https://a.com and /tmp/x.txt.";
        assert_eq!(find(text, 0), None);
        assert_eq!(find(text, 4).map(|r| &text[r]), Some("https://a.com"));
        assert_eq!(find(text, 16).map(|r| &text[r]), Some("https://a.com"));
        assert_eq!(find(text, 17), None);
        assert_eq!(find(text, 25).map(|r| &text[r]), Some("/tmp/x.txt."));
    }

    #[test]
    fn extracts_address_words_at_the_pointer() {
        for (text, expected) in [
            ("<t1hg>", "t1hg"),
            ("[\"macbook/t2w\"]", "macbook/t2w"),
            ("terminal=t1hg,", "t1hg"),
            ("'my-machine_2/t2w'.", "my-machine_2/t2w"),
            ("before t1hg after", "t1hg"),
            ("é t1hg", "t1hg"),
            ("<build.box/t1>.", "build.box/t1"),
            ("1.2.3.4/t1", "1.2.3.4/t1"),
            ("...t1hg.", "t1hg"),
        ] {
            let at = text.find(expected).unwrap();
            for (i, _) in expected.char_indices() {
                assert_eq!(word(text, at + i).map(|r| &text[r]), Some(expected), "{text}");
            }
        }
        for (text, at) in [("<t1>", 0), ("t1 ", 2), ("", 0), ("t1", 2), ("é", 1)] {
            assert_eq!(word(text, at), None);
        }
    }

    #[test]
    fn matches_only_live_addresses_relative_to_the_source_machine() {
        let live = ["t1", "t2", "macbook/t1", "macbook/t2w", "my-machine_2/t3", "build.box/t1", "box/t1"];
        for (word, source, expected) in [
            ("t1", "t2", Some("t1")),
            ("t1", "macbook/t2w", Some("macbook/t1")),
            ("t1", "build.box/t2", Some("build.box/t1")),
            ("t2", "macbook/t1", None),
            ("macbook/t2w", "t1", Some("macbook/t2w")),
            ("my-machine_2/t3", "macbook/t1", Some("my-machine_2/t3")),
            ("t99", "t1", None),
            ("Build", "t1", None),
            ("t", "t1", None),
            ("other/t1", "t1", None),
            ("macbook/t1/extra", "t1", None),
        ] {
            assert_eq!(terminal_address(word, source, live), expected.map(str::to_owned), "{word} in {source}");
        }
    }

    #[test]
    fn dotted_machines_never_match_a_different_suffix_machine() {
        let text = "<build.box/t1>.";
        let range = word(text, text.find("t1").unwrap()).unwrap();
        assert_eq!(&text[range.clone()], "build.box/t1");
        assert_eq!(terminal_address(&text[range.clone()], "t2", ["box/t1"]), None);
        assert_eq!(terminal_address(&text[range], "t2", ["box/t1", "build.box/t1"]), Some("build.box/t1".into()));
    }

    #[test]
    fn files_resolve_only_when_they_exist() {
        let dir = std::env::temp_dir().join(format!("herdr-links-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "").unwrap();
        let file = Target::File(dir.join("src/main.rs"));
        assert_eq!(resolve("src/main.rs", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/main.rs:42:7", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/main.rs.", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve("src/.", Some(&dir)), Some(Target::File(dir.join("src/."))));
        assert_eq!(resolve("src/..", Some(&dir)), Some(Target::File(dir.join("src/.."))));
        assert_eq!(resolve("$PWD/src/main.rs", Some(&dir)), Some(file.clone()));
        assert_eq!(resolve(dir.join("src/main.rs").to_str().unwrap(), None), Some(file));
        assert_eq!(resolve("src/gone.rs", Some(&dir)), None);
        assert_eq!(resolve("src/main.rs", None), None);
        assert_eq!(resolve("https://a.com/x", None), Some(Target::Url("https://a.com/x".into())));
        #[cfg(unix)]
        {
            let dotted = dir.join("src/main.rs.");
            std::fs::write(&dotted, "").unwrap();
            assert_eq!(resolve("src/main.rs.", Some(&dir)), Some(Target::File(dotted)));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
