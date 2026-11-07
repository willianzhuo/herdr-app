#!/usr/bin/env python3
"""Install a user-owned Bash guard for Herdr's requested working directory.

Run on the terminal's machine. No existing process is changed. Platform-generated
.bash_aliases files are deliberately untouched; the guard survives their rewrite.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

HOOK = r'''# Herdr directory guard v1; sourced by the managed .bashrc blocks.
case "${1-}" in
capture)
    if [[ $- == *i* && -n ${HC_TERMINAL_ID-} && ${__HERDR_DIRECTORY_TERMINAL-} != "$HC_TERMINAL_ID" ]]; then
        export __HERDR_DIRECTORY_START="$PWD"
        export __HERDR_DIRECTORY_TERMINAL="$HC_TERMINAL_ID"
    fi
    ;;
restore)
    if [[ $- == *i* && -n ${HC_TERMINAL_ID-} && ${__HERDR_DIRECTORY_TERMINAL-} == "$HC_TERMINAL_ID" && -n ${__HERDR_DIRECTORY_START-} ]]; then
        builtin cd -- "$__HERDR_DIRECTORY_START" 2>/dev/null || :
        unset __HERDR_DIRECTORY_START __HERDR_DIRECTORY_TERMINAL
    fi
    ;;
esac
'''


def block(phase):
    return (
        '# >>> herdr directory ' + phase + ' v1 >>>\n'
        'if [ -n "${BASH_VERSION-}" ] && [ -r "$HOME/.config/herdr-custom/shell-directory.bash" ]; then\n'
        '    . "$HOME/.config/herdr-custom/shell-directory.bash" ' + phase + '\n'
        'fi\n'
        '# <<< herdr directory ' + phase + ' v1 <<<\n'
    )


def unmanage(text):
    for phase in ('capture', 'restore'):
        begin = '# >>> herdr directory ' + phase + ' v1 >>>'
        end = '# <<< herdr directory ' + phase + ' v1 <<<'
        if text.count(begin) != text.count(end) or text.count(begin) > 1:
            raise ValueError('ambiguous managed .bashrc markers; leaving file unchanged')
        if begin in text:
            pattern = re.escape(begin) + r'\n.*?' + re.escape(end) + r'\n?'
            text, count = re.subn(pattern, '', text, flags=re.S)
            if count != 1:
                raise ValueError('cannot locate managed .bashrc block')
    return text


def atomic_write(path, text, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, scratch = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(scratch, path)
    finally:
        if os.path.exists(scratch):
            os.unlink(scratch)


def install(home, remove=False):
    rc = home / '.bashrc'
    if os.name != 'posix' or not rc.is_file():
        return {'status': 'unsupported', 'reason': 'no user Bash startup file'}
    # Preserve a user's .bashrc symlink and update its target atomically.
    rc = rc.resolve()
    original = rc.read_text(encoding='utf-8')
    clean = unmanage(original)
    hook = home / '.config/herdr-custom/shell-directory.bash'
    if remove:
        if clean != original:
            atomic_write(rc, clean, stat.S_IMODE(rc.stat().st_mode))
        if hook.is_file() and hook.read_text(encoding='utf-8') == HOOK:
            hook.unlink()
        return {'status': 'removed'}
    wanted = block('capture') + clean + ('' if clean.endswith('\n') else '\n') + block('restore')
    unchanged = original == wanted and hook.is_file() and hook.read_text(encoding='utf-8') == HOOK
    if unchanged:
        return {'status': 'unchanged'}
    # Keep the first original beside .bashrc, without copying platform exports.
    backup = rc.with_name(rc.name + '.herdr-directory-v1.bak')
    try:
        fd = os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(original)
    atomic_write(hook, HOOK, 0o600)
    if wanted != original:
        atomic_write(rc, wanted, stat.S_IMODE(rc.stat().st_mode))
    return {'status': 'installed'}


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--remove']):
        raise SystemExit('usage: install-shell-directory.py [--remove]')
    print(json.dumps(install(Path.home(), sys.argv[1:] == ['--remove'])))
