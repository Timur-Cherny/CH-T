import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader('brain', str(ROOT / 'bin/brain'))
spec = importlib.util.spec_from_loader(loader.name, loader)
brain = importlib.util.module_from_spec(spec)
loader.exec_module(brain)


class PortableTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='TEST brain ')
        self.base = Path(self.tmp.name).resolve()
        self.repo = self.base / 'checkout with spaces'
        self.repo.mkdir()
        for argv in [['git', 'init', '-q'], ['git', 'config', 'user.email', 'test@example.invalid'],
                     ['git', 'config', 'user.name', 'TEST'], ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'TEST', '--allow-empty']]:
            subprocess.run(argv, cwd=self.repo, check=True)
        self.state = patch.object(brain, 'STATE', self.base / 'state')
        self.state.start()

    def tearDown(self):
        self.state.stop()
        self.tmp.cleanup()

    def test_management_commands_reexec_python311_but_hook_stays_python39_compatible(self):
        class Reexec(Exception):
            pass
        with patch.object(brain.sys, 'version_info', (3, 9, 6)), \
             patch.object(brain.shutil, 'which', return_value='/test/python3.11'), \
             patch.object(brain, 'run', return_value=b'Python 3.11.9'), \
             patch.object(brain.os, 'execv', side_effect=Reexec) as execv:
            with self.assertRaises(Reexec):
                brain.ensure_management_python()
            self.assertEqual(execv.call_args.args[0], '/test/python3.11')
        with patch.object(brain.sys, 'version_info', (3, 9, 6)), patch.object(brain.sys, 'argv', ['brain', 'hook']), \
             patch.object(brain.shutil, 'which') as which:
            brain.ensure_management_python()
            which.assert_not_called()

    def test_checkpoint_records_explicit_note_and_detects_untracked_change(self):
        note = self.base / 'note.md'
        note.write_text('Goal: test. Verified: one case. Next: another case.')
        args = type('Args', (), {'cwd': self.repo, 'task': 'returns', 'file': note})
        brain.checkpoint(args)
        self.assertIn('совпадает', brain.context(self.repo, 'returns'))
        (self.repo / 'new.txt').write_text('one')
        self.assertIn('изменился', brain.context(self.repo, 'returns'))
        before = brain.identity(self.repo)
        (self.repo / 'new.txt').write_text('two')
        self.assertNotEqual(before['tree'], brain.identity(self.repo)['tree'])
        saved = brain.task_file(self.repo, 'returns')
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)

    def test_task_and_checkout_isolation(self):
        self.assertNotEqual(brain.task_file(self.repo, 'a'), brain.task_file(self.repo, 'b'))
        self.assertNotEqual(brain.task_file(self.repo, 'a'), brain.task_file(self.base, 'a'))
        self.assertIn('ещё не сохранён', brain.context(self.repo, 'a'))

    def test_checkpoint_rejects_cross_repo_record(self):
        saved = brain.task_file(self.repo, 'a')
        brain.atomic_write(saved, json.dumps({'repo': '/wrong', 'task': 'a', 'note': 'wrong'}))
        with self.assertRaisesRegex(ValueError, 'другому'):
            brain.context(self.repo, 'a')

    def test_profile_valid_and_does_not_override_model_or_permissions(self):
        import tomllib
        config = tomllib.loads(brain.profile_text())
        self.assertTrue(set(config) <= {'features', 'mcp_servers'})
        self.assertFalse({'model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'} & set(config))
        self.assertNotIn('hooks', config, 'User hooks cover Desktop and CLI without profile duplicates')

    def test_profile_turns_off_what_the_adapter_cannot_see(self):
        # Codex memories are a second memory outside MEMORY.md; subagents, plugins and apps bring tools the adapter
        # never judges.
        import tomllib
        config = tomllib.loads(brain.profile_text())
        self.assertEqual(config['features'], {'hooks': True, 'memories': False, 'multi_agent': False, 'plugins': False, 'apps': False})
        self.assertNotIn('hooks', config)

    def test_profile_timeouts_never_shorter_than_claude_settings(self):
        # Codex kills a hook on its timeout and the call goes through; resource-guard alone may wait 240 s.
        import tomllib
        profile = json.loads(brain.hooks_text())['hooks']
        claude = json.loads((ROOT / 'settings.json').read_text())['hooks']
        for event, entries in profile.items():
            ours = next(h['timeout'] for e in entries for h in e['hooks'] if h.get('statusMessage') == brain.HOOKS_MARKER)
            theirs = max(h.get('timeout', 0) for e in claude.get(event, []) for h in e.get('hooks', []))
            self.assertGreaterEqual(ours, theirs, f'{event}: Miss this and a deny issued after {ours} s is lost')

    def test_profile_reconcile_preserves_codex_state_but_moves_legacy_hooks_out(self):
        import tomllib
        legacy = brain.profile_text() + (
            '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "old hook"\n'
            '[hooks.state]\n"session_start:0:0" = "trusted-hash"\n'
            '[tui]\nscreen_reader_detection_done = true\n')
        updated = brain.profile_for_install(brain.profile_text(), legacy)
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed['hooks']['state']['session_start:0:0'], 'trusted-hash')
        self.assertTrue(parsed['tui']['screen_reader_detection_done'])
        self.assertNotIn('SessionStart', parsed['hooks'])
        self.assertNotIn('old hook', updated)

    def test_profile_current_ignores_codex_owned_metadata_but_rejects_old_profile_hooks(self):
        home = self.base / 'codex-home'
        home.mkdir()
        path = home / 'brain.config.toml'
        with patch.dict(os.environ, {'CODEX_HOME': str(home)}):
            path.write_text(brain.profile_text() + '[hooks.state]\n"stop:0:0" = "trusted"\n[tui]\nscreen_reader_detection_done = true\n')
            self.assertTrue(brain.profile_is_current(path))
            path.write_text(brain.profile_text() + '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "old"\n')
            self.assertFalse(brain.profile_is_current(path))

    def test_global_hooks_merge_without_dropping_unrelated_handlers(self):
        existing = {'description': 'user hooks', 'hooks': {
            'PreToolUse': [{'matcher': '^Bash$', 'hooks': [{'type': 'command', 'command': 'user hook'}]},
                           {'matcher': '.*', 'hooks': [{'type': 'command', 'command': 'stale', 'statusMessage': brain.HOOKS_MARKER}]}],
            'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'other'}]}]}}
        result = json.loads(brain.hooks_text(existing))
        self.assertEqual(result['description'], 'user hooks')
        self.assertEqual(result['hooks']['PreToolUse'][0]['hooks'][0]['command'], 'user hook')
        managed = result['hooks']['PreToolUse'][1]['hooks'][0]
        self.assertEqual(managed['statusMessage'], brain.HOOKS_MARKER)
        self.assertEqual(result['hooks']['UserPromptSubmit'], existing['hooks']['UserPromptSubmit'])

    def test_profile_disables_every_base_mcp_server_except_the_listed_ones(self):
        import tomllib
        home = self.base / 'codex'
        home.mkdir()
        (home / 'config.toml').write_text(
            '[mcp_servers.node_repl]\ncommand = "x"\nargs = ["mcp"]\ncwd = "."\n[mcp_servers.node_repl.env]\nTOKEN = "secret"\n'
            '[mcp_servers.tracker]\ncommand = "y"\n[mcp_servers."odd name"]\nurl = "https://z.invalid/mcp"\n')
        with patch.dict(os.environ, {'CODEX_HOME': str(home)}), patch.object(brain, 'config', return_value={'mcpAllowed': ['tracker']}):
            servers = tomllib.loads(brain.profile_text()).get('mcp_servers', {})
        self.assertEqual(set(servers), {'node_repl', 'odd name'},
                         'Miss this and node_repl runs arbitrary Node past every pre-bash gate')
        # Codex 0.158 refuses every config write, hook trust included, while a server in the profile has no transport.
        self.assertEqual(servers['node_repl'], {'command': 'x', 'args': ['mcp'], 'cwd': '.', 'enabled': False})
        self.assertEqual(servers['odd name'], {'url': 'https://z.invalid/mcp', 'enabled': False})

    def test_hook_pins_the_checkout_site_config_like_the_shims(self):
        # Harness v5 moved company hosts into harness.config.json; the shims pin the checkout's copy, the Codex hook
        # bypasses them, and without it owner-actions knew no company host at all.
        site = self.base / 'site'
        site.mkdir()
        (site / 'harness.config.json').write_text('{}')
        own = str((site / 'harness.config.json').resolve())
        with tempfile.TemporaryDirectory() as home, patch.object(brain, 'ROOT', site):
            env = brain.hook_env({'HOME': home, 'PATH': '/usr/bin'}, '/usr/bin/node')
            self.assertEqual(env.get('CLAUDE_HARNESS_CONFIG'), own,
                             'Miss this and a Codex executor pushes a tag past owner-actions, which knows no company host')
            self.assertEqual(brain.hook_env({'HOME': home, 'CLAUDE_HARNESS_CONFIG': '/x.json'}, '/usr/bin/node')['CLAUDE_HARNESS_CONFIG'], '/x.json')
            Path(home, '.claude').mkdir()
            os.symlink(Path(home, 'nowhere.json'), Path(home, '.claude', 'harness.config.json'))
            self.assertNotIn('CLAUDE_HARNESS_CONFIG', brain.hook_env({'HOME': home}, '/usr/bin/node'),
                             'a config the owner linked in HOME outranks the checkout, even dangling — as in node-pin.sh')

    def test_install_idempotent_and_preserves_user_configuration(self):
        home = self.base / 'home'
        home.mkdir()
        config = home / '.codex'
        config.mkdir()
        sentinel = config / 'config.toml'
        sentinel.write_text('model = "unchanged"\n')
        with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'CODEX_HOME': str(config)}), patch.object(brain, 'runtime', return_value='/node'):
            brain.install()
            first = brain.profile_path().read_bytes()
            first_hooks = brain.hooks_path().read_bytes()
            brain.install()
            self.assertEqual(first, brain.profile_path().read_bytes())
            self.assertEqual(first_hooks, brain.hooks_path().read_bytes())
            self.assertEqual(sentinel.read_text(), 'model = "unchanged"\n')
            self.assertTrue((home / '.local/bin/brain').is_symlink())
            self.assertTrue(brain.profile_is_current())
            self.assertTrue(brain.hooks_are_current())

    def test_install_refuses_existing_unowned_profile(self):
        path = self.base / 'brain.config.toml'
        path.write_text('model="do-not-overwrite"')
        with patch.object(brain, 'profile_path', return_value=path), patch.object(brain, 'runtime', return_value='/node'):
            with self.assertRaisesRegex(ValueError, 'не принадлежит'):
                brain.install()
        self.assertEqual(path.read_text(), 'model="do-not-overwrite"')

    def test_install_migrates_legacy_profile_and_preserves_codex_metadata_and_other_hooks(self):
        import tomllib
        home = self.base / 'home-legacy'
        codex = home / '.codex'
        codex.mkdir(parents=True)
        legacy = codex / 'brain.config.toml'
        legacy.write_text(
            brain.PROFILE_MARKER
            + '[features]\nhooks = true\nmemories = false\nmulti_agent = false\nplugins = false\napps = false\n'
            + '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "old brain hook"\n'
            + '[hooks.state]\n"session_start:0:0" = "trusted-state"\n'
            + '[tui]\nscreen_reader_detection_done = true\n')
        hooks = codex / 'hooks.json'
        hooks.write_text(json.dumps({'hooks': {'PreToolUse': [{'matcher': '^Bash$', 'hooks': [
            {'type': 'command', 'command': 'user hook'}]}], 'UserPromptSubmit': [{'hooks': [
            {'type': 'command', 'command': 'other'}]}]}}))
        with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'CODEX_HOME': str(codex)}), patch.object(brain, 'runtime', return_value='/node'):
            brain.install()
            profile = tomllib.loads(legacy.read_text())
            merged_hooks = json.loads(hooks.read_text())['hooks']
            self.assertTrue(brain.profile_is_current(legacy))
            self.assertEqual(profile['hooks']['state']['session_start:0:0'], 'trusted-state')
            self.assertTrue(profile['tui']['screen_reader_detection_done'])
            self.assertNotIn('SessionStart', profile['hooks'])
            self.assertEqual(merged_hooks['PreToolUse'][0]['hooks'][0]['command'], 'user hook')
            self.assertEqual(merged_hooks['UserPromptSubmit'][0]['hooks'][0]['command'], 'other')
            self.assertTrue(brain.hooks_are_current(hooks))

    def test_launch_uses_argv_without_shell_and_preserves_native_model(self):
        args = type('Args', (), {'cwd': self.repo, 'task': 'a', 'agent': 'claude', 'dry_run': False,
                                'args': ['--', '--model', 'selected-model'], 'model': None, 'effort': None})
        original = subprocess.Popen
        calls = []

        def execute(argv, **kwargs):
            if argv[0] == '/test/claude':
                calls.append((argv, kwargs))
                return type('Child', (), {'wait': lambda self: 0})()
            return original(argv, **kwargs)

        with patch.object(brain.shutil, 'which', return_value='/test/claude'), patch.object(brain.subprocess, 'Popen', side_effect=execute):
            brain.launch(args)
        self.assertEqual(calls[0][0][-2:], ['--model', 'selected-model'])
        self.assertEqual(calls[0][1]['cwd'], self.repo)
        self.assertNotIn('shell', calls[0][1])
        self.assertTrue(calls[0][1]['pass_fds'])
        self.assertIn('runtimes/WORKFLOW.md', calls[0][0][2])

    def test_checkpoint_lock_blocks_second_launch_even_with_other_task(self):
        import fcntl
        import hashlib
        lock = brain.STATE / 'locks' / (hashlib.sha256(str(self.repo).encode()).hexdigest() + '.lock')
        lock.parent.mkdir(parents=True)
        args = type('Args', (), {'cwd': self.repo, 'task': 'different', 'agent': 'claude', 'dry_run': False, 'args': []})
        with lock.open('a') as stream, patch.object(brain.shutil, 'which', return_value='/test/claude'):
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'уже работает'):
                brain.launch(args)

    def test_launcher_rejects_overriding_working_directory(self):
        args = type('Args', (), {'cwd': self.repo, 'task': 'a', 'agent': 'codex', 'dry_run': True, 'args': ['--', '-C', '/wrong']})
        with self.assertRaisesRegex(ValueError, '--cwd'):
            brain.launch(args)

    def test_atomic_write_replaces_instead_of_following_destination_symlink(self):
        target = self.base / 'private.txt'
        target.write_text('do not change')
        dest = self.base / 'checkpoint.json'
        dest.symlink_to(target)
        brain.atomic_write(dest, '{}')
        self.assertEqual(target.read_text(), 'do not change')
        self.assertFalse(dest.is_symlink())


    def test_agy_hooks_merge_keeps_other_named_hooks_and_is_idempotent(self):
        path = self.base / 'gemini' / 'hooks.json'
        path.parent.mkdir()
        path.write_text(json.dumps({'sonar': {'PreToolUse': [{'matcher': 'run_command', 'hooks': [{'command': '/x'}]}]}}))
        with patch.dict(os.environ, {'BRAIN_AGY_HOOKS': str(path)}), patch.object(brain, 'runtime', return_value='/node'), \
             patch.object(Path, 'home', return_value=self.base):
            brain.install(['agy'])
            first = path.read_text()
            brain.install(['agy'])
            doc = json.loads(path.read_text())
            self.assertEqual(first, path.read_text())
            self.assertIn('sonar', doc)
            self.assertTrue(brain.agy_hooks_are_current(path))
            entry = doc[brain.AGY_KEY]
            self.assertEqual(set(entry) - {'enabled'}, set(brain.AGY_EVENTS))
            self.assertEqual(entry['PreToolUse'][0]['matcher'], '*')
            self.assertTrue(entry['Stop'][0]['command'].endswith('hook agy Stop'))

    def test_executor_env_drops_credentials_but_keeps_its_own_login(self):
        environ = {'PATH': '/bin', 'GITHUB_TOKEN': 'x', 'PGPASSWORD': 'x', 'AWS_PROFILE': 'p', 'OPENAI_API_KEY': 'k', 'ANTHROPIC_API_KEY': 'a'}
        with patch.object(brain, 'config', return_value={'envKeep': ['GITHUB_TOKEN']}):
            env, dropped = brain.child_env(environ, 'codex')
        self.assertEqual(set(env), {'PATH', 'GITHUB_TOKEN', 'OPENAI_API_KEY'})
        self.assertEqual(dropped, ['ANTHROPIC_API_KEY', 'AWS_PROFILE', 'PGPASSWORD'])

    def test_model_and_effort_reach_codex_as_native_flags_and_agy_refuses_them(self):
        with patch.object(brain, 'profile_is_current', return_value=True), patch.object(brain, 'hooks_are_current', return_value=True):
            argv = brain.launch_argv('codex', '/c', 'CTX', ['--search'], 'gpt-x', 'high')
        self.assertEqual(argv, ['/c', '-p', 'brain', '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"', '--search', 'CTX'])
        with patch.object(brain, 'agy_hooks_are_current', return_value=True):
            with self.assertRaisesRegex(ValueError, 'agy'):
                brain.launch_argv('agy', '/a', 'CTX', [], 'm', None)
            self.assertEqual(brain.launch_argv('agy', '/a', 'CTX', ['--x'], None, None), ['/a', '--x'])
        self.assertEqual(brain.launch_argv('claude', '/cl', 'CTX', [], 'opus', None)[-2:], ['--model', 'opus'])

    def test_local_launch_names_repo_model_and_context_budget(self):
        args = type('Args', (), {'cwd': self.repo, 'task': 't', 'llm': 'http://127.0.0.1:1/v1', 'model': None, 'port': 9999,
                                'max_steps': None, 'context': 32000, 'no_open': True, 'dry_run': True})
        out = []
        with patch.object(brain, 'ensure_llm'), patch.object(brain, 'runtime', return_value='/node'), \
             patch.object(brain, 'config', return_value={'local': {'model': '/models/qwen'}}), patch('builtins.print', side_effect=out.append):
            brain.local(args)
        argv = json.loads(out[0])['argv']
        self.assertEqual(argv[argv.index('--repo') + 1], str(self.repo))
        self.assertEqual(argv[argv.index('--model') + 1], '/models/qwen')
        self.assertEqual(argv[argv.index('--context') + 1], '32000')
        self.assertTrue(argv[2].endswith('runtimes/local/agent.ts'))


    def test_hook_failure_is_the_clients_explicit_deny_never_a_pass(self):
        pre = json.dumps({'hook_event_name': 'PreToolUse'}).encode()
        def boom(*a, **k):
            raise brain.subprocess.TimeoutExpired('node', 1)
        with patch.object(brain, 'runtime', return_value='/node'), patch.object(brain.subprocess, 'run', side_effect=boom):
            out, err, rc = brain.run_adapter('codex', [], pre, {'HOME': str(self.base)})
            self.assertEqual(rc, 2, 'Miss this and a hook that ran out of time lets the call through')
            self.assertIn('таймаут', err.decode())
            out, err, rc = brain.run_adapter('agy', ['PreToolUse'], b'{}', {'HOME': str(self.base)})
            self.assertEqual((json.loads(out)['decision'], rc), ('deny', 0))
        crashed = type('R', (), {'returncode': 1, 'stdout': b'', 'stderr': b'SyntaxError'})()
        with patch.object(brain, 'runtime', return_value='/node'), patch.object(brain.subprocess, 'run', return_value=crashed):
            self.assertEqual(brain.run_adapter('codex', [], pre, {'HOME': str(self.base)})[2], 2)
            self.assertEqual(json.loads(brain.run_adapter('agy', ['PreToolUse'], b'{}', {'HOME': str(self.base)})[0])['decision'], 'deny')
            self.assertEqual(brain.run_adapter('codex', [], json.dumps({'hook_event_name': 'PostToolUse'}).encode(), {'HOME': str(self.base)})[2], 0)
        with patch.object(brain, 'runtime', side_effect=ValueError('Node >=24 не найден')):
            self.assertEqual(brain.run_adapter('codex', [], b'not json', {'HOME': str(self.base)})[2], 2)

    def test_codex_launch_refuses_flags_that_rewrite_the_brain_profile(self):
        for flag in (['-c', 'features.hooks=false'], ['--config', 'x=1'], ['--disable', 'hooks'], ['--enable=x']):
            args = type('Args', (), {'cwd': self.repo, 'task': 'a', 'agent': 'codex', 'dry_run': True, 'args': ['--', *flag], 'model': None, 'effort': None})
            with self.assertRaisesRegex(ValueError, 'профиль brain'):
                brain.launch(args)

    def test_install_without_flags_touches_codex_only_and_odd_config_is_ignored(self):
        home = self.base / 'home-only-codex'
        (home / '.gemini').mkdir(parents=True)
        with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'CODEX_HOME': str(home / '.codex'), 'BRAIN_AGY_HOOKS': str(home / '.gemini/config/hooks.json')}), \
             patch.object(brain, 'runtime', return_value='/node'), patch.object(brain, 'config', return_value={'mcpAllowed': 5, 'envKeep': 'x'}):
            brain.install()
            self.assertFalse((home / '.gemini/config/hooks.json').exists())
            self.assertEqual(brain.allowed_mcp(), set())
            self.assertEqual(brain.child_env({'X_TOKEN': '1'}, 'claude')[1], ['X_TOKEN'])

    def test_executor_env_drops_dsn_ssh_agent_and_pats(self):
        env, dropped = brain.child_env({'PATH': '/b', 'PWD': '/x', 'DATABASE_URL': 'postgres://u:p@h/db', 'SSH_AUTH_SOCK': '/s', 'GITHUB_PAT': 'g', 'DB_PASS': 'p', 'ORDERS_DSN': 'd'}, 'claude')
        self.assertEqual(set(env), {'PATH', 'PWD'})


if __name__ == '__main__':
    unittest.main()
