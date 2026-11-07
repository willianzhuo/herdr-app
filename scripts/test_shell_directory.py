import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('directory_installer', Path(__file__).with_name('install-shell-directory.py'))
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class DirectoryGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="herdr directory ' ")
        self.home = Path(self.tmp.name).resolve()
        self.work = self.home / "project ' work"
        self.work.mkdir()
        (self.home / 'init').mkdir()
        (self.home / '.bashrc').write_text(
            '# user configuration\n. "$HOME/.bash_aliases"\nexport FIXTURE_LOADED=yes\n')
        (self.home / '.bash_aliases').write_text('cd "$HOME/init"\n')

    def tearDown(self):
        self.tmp.cleanup()

    def shell(self, herdr=True, interactive=True):
        env = dict(os.environ, HOME=str(self.home), TERM='dumb')
        for key in ['HC_TERMINAL_ID', '__HERDR_DIRECTORY_START', '__HERDR_DIRECTORY_TERMINAL', 'FIXTURE_EXECED']:
            env.pop(key, None)
        if herdr:
            env['HC_TERMINAL_ID'] = 't1'
        command = 'printf "RESULT:%s|%s|%s\\n" "$PWD" "${FIXTURE_LOADED-}" "${__HERDR_DIRECTORY_START-unset}"\nexit\n'
        argv = ['/bin/bash', '--noprofile', '--rcfile', str(self.home / '.bashrc')]
        if interactive:
            argv += ['-i']
        else:
            argv += ['-c', '. "$HOME/.bashrc"; ' + command]
        result = subprocess.run(argv, input=command, cwd=self.work, env=env, text=True,
                                capture_output=True, timeout=8, start_new_session=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return next(line for line in result.stdout.splitlines() if line.startswith('RESULT:'))

    def test_preserves_requested_directory_and_user_environment(self):
        self.assertIn(str(self.home / 'init'), self.shell())
        INSTALLER.install(self.home)
        self.assertEqual(self.shell(), 'RESULT:' + str(self.work) + '|yes|unset')
        self.assertEqual(self.shell(herdr=False), 'RESULT:' + str(self.home / 'init') + '|yes|unset')
        self.assertEqual(self.shell(interactive=False), 'RESULT:' + str(self.home / 'init') + '|yes|unset')

    def test_survives_platform_exec_and_aliases_regeneration(self):
        INSTALLER.install(self.home)
        # The platform replaces Bash during startup; pending shell commands and
        # non-exported locals would be lost. The new Bash reads the same stdin.
        (self.home / '.bash_aliases').write_text('''cd "$HOME/init"
if [[ -z ${FIXTURE_EXECED-} ]]; then
    export FIXTURE_EXECED=1
    exec /bin/bash --noprofile --rcfile "$HOME/.bashrc" -i
fi
''')
        self.assertEqual(self.shell(), 'RESULT:' + str(self.work) + '|yes|unset')
        self.assertIn(str(self.home / 'init'), self.shell(herdr=False))

    def test_idempotent_install_backup_symlink_and_remove(self):
        rc = self.home / '.bashrc'
        original = rc.read_bytes()
        target = self.home / 'user bashrc'
        rc.rename(target)
        rc.symlink_to(target)
        self.assertEqual(INSTALLER.install(self.home)['status'], 'installed')
        installed = rc.read_bytes()
        self.assertEqual(INSTALLER.install(self.home)['status'], 'unchanged')
        self.assertEqual(rc.read_bytes(), installed)
        self.assertTrue(rc.is_symlink())
        self.assertEqual(target.with_name(target.name + '.herdr-directory-v1.bak').read_bytes(), original)
        INSTALLER.install(self.home, remove=True)
        self.assertEqual(rc.read_bytes(), original)
        self.assertFalse((self.home / '.config/herdr-custom/shell-directory.bash').exists())

    def test_ambiguous_markers_fail_without_changing_files(self):
        rc = self.home / '.bashrc'
        rc.write_text('# >>> herdr directory capture v1 >>>\nuser edit\n')
        original = rc.read_bytes()
        with self.assertRaises(ValueError):
            INSTALLER.install(self.home)
        self.assertEqual(rc.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
