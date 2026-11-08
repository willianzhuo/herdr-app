#!/usr/bin/env python3
"""Remove inherited NO_COLOR in new interactive Herdr zsh shells only."""
import argparse
from pathlib import Path
import re
import stat
import tempfile

START = "# >>> herdr-custom interactive-colors-v1 >>>"
END = "# <<< herdr-custom interactive-colors-v1 <<<"
BLOCK = START + """
# Herdr terminals are interactive; a launcher may have disabled its own logs.
if [ -n "${HC_TERMINAL_ID-}" ]; then
    unset NO_COLOR
fi
""" + END + "\n"


def install(home, remove=False):
    profile = home / ".zshrc"
    original = profile.read_text() if profile.exists() else ""
    clean = re.sub(r"(?m)^" + re.escape(START) + r"\n.*?^" + re.escape(END) + r"\n?", "", original, flags=re.S)
    updated = clean if remove else clean.rstrip("\n") + ("\n\n" if clean.rstrip("\n") else "") + BLOCK
    if updated == original:
        return profile
    backup = profile.with_name(profile.name + ".herdr-colors-v1.bak")
    if profile.exists() and not backup.exists():
        backup.write_bytes(profile.read_bytes())
        backup.chmod(stat.S_IMODE(profile.stat().st_mode))
    mode = stat.S_IMODE(profile.stat().st_mode) if profile.exists() else 0o600
    with tempfile.NamedTemporaryFile(dir=home, prefix=".herdr-colors-", delete=False, mode="w") as f:
        f.write(updated)
        staged = Path(f.name)
    try:
        staged.chmod(mode)
        staged.replace(profile)
    finally:
        staged.unlink(missing_ok=True)
    return profile


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    print(install(args.home, args.remove))
