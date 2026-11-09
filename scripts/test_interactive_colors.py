import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("colors", Path(__file__).with_name("install-interactive-colors.py"))
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class ColorGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="herdr colors ")
        self.home = Path(self.tmp.name)
        self.rc = self.home / ".bashrc"
        self.rc.write_text("# user startup\nexport USER_CONFIGURATION=kept\n")

    def tearDown(self):
        self.tmp.cleanup()

    def run_shell(self, interactive=True, herdr=True):
        env = {**os.environ, "HOME":str(self.home), "NO_COLOR":"1", "TERM":"xterm-256color"}
        env.pop("HC_TERMINAL_ID", None)
        if herdr:
            env["HC_TERMINAL_ID"] = "test"
        command = 'printf "COLORS:%s|%s\\n" "${NO_COLOR-unset}" "$USER_CONFIGURATION"'
        args = ["/bin/bash", "--noprofile", "--rcfile", str(self.rc)]
        args += ["-ic", command] if interactive else ["-c", '. "$HOME/.bashrc"; ' + command]
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=6)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_only_interactive_herdr_bash_clears_color_suppression(self):
        INSTALLER.install(self.home, shell="bash")
        self.assertEqual(self.run_shell(), "COLORS:unset|kept")
        self.assertEqual(self.run_shell(herdr=False), "COLORS:1|kept")
        self.assertEqual(self.run_shell(interactive=False), "COLORS:1|kept")

    def test_clears_before_platform_exec_replaces_bash(self):
        self.rc.write_text('''if [ -z "${EXECED-}" ]; then
export EXECED=1
exec /bin/bash --noprofile --rcfile "$HOME/.bashrc" -ic 'printf "COLORS:%s|%s\\n" "${NO_COLOR-unset}" "$USER_CONFIGURATION"'
fi
export USER_CONFIGURATION=kept
''')
        INSTALLER.install(self.home, shell="bash")
        self.assertEqual(self.run_shell(), "COLORS:unset|kept")

    def test_idempotent_symlink_permissions_backup_and_remove(self):
        original = self.rc.read_bytes()
        target = self.home / "shared bashrc"
        self.rc.rename(target); target.chmod(0o640); self.rc.symlink_to(target)
        INSTALLER.install(self.home, shell="bash")
        first = target.read_bytes(); INSTALLER.install(self.home, shell="bash")
        self.assertEqual(target.read_bytes(), first)
        self.assertTrue(self.rc.is_symlink())
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        self.assertEqual(target.with_name(target.name + ".herdr-colors-v1.bak").read_bytes(), original)
        INSTALLER.install(self.home, remove=True, shell="bash")
        self.assertEqual(target.read_bytes(), original)

    def test_ambiguous_markers_leave_file_unchanged(self):
        self.rc.write_text(INSTALLER.START + "\nuser text\n")
        original = self.rc.read_bytes()
        with self.assertRaises(ValueError):
            INSTALLER.install(self.home, shell="bash")
        self.assertEqual(self.rc.read_bytes(), original)

    def test_zsh_default_remains_compatible(self):
        rc = self.home / ".zshrc"; rc.write_text("# existing zsh\n")
        INSTALLER.install(self.home)
        self.assertEqual(rc.read_text(), "# existing zsh\n\n" + INSTALLER.BLOCK)


if __name__ == "__main__":
    unittest.main()
