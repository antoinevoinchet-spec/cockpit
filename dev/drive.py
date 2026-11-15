#!/usr/bin/env python3
"""Drive a throwaway Claude Code session with this mod loaded, and read its screen.

    python3 dev/drive.py "Reponds juste: bonjour"
    python3 dev/drive.py "Reponds juste: salut" "/reload-plugins" "Reponds juste: bonjour"
    python3 dev/drive.py --two-part "Reponds juste: rebonjour"

Each step is typed in the session: a prompt waits for the turn's end, a /command for the
screen to settle, and a step starting with "!" runs in a shell here instead (to change the
mod's files between two steps). The screen after each step is kept in
~/.cache/cockpit-dev/screens/, and the transcript side of the last one is printed.

The session is kept apart from your own: a clean environment (none of the calling
session's variables, which would let it reach that session), the installed Cockpit disabled
(the copy loaded instead writes to the cockpit_inline store, never the main one), no MCP
server, Haiku, its own folder ~/.cache/cockpit-dev/work, and every permission question
refused unless --approve. pyte, the screen emulator, is installed on the first run in
~/.cache/cockpit-dev/venv.
"""

import argparse
import fcntl
import glob
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HOME = os.path.expanduser('~')
CACHE = os.path.join(HOME, '.cache', 'cockpit-dev')
VENV = os.path.join(CACHE, 'venv')
WORK = os.path.join(CACHE, 'work')
COPY = os.path.join(CACHE, 'cockpit')
SCREENS = os.path.join(CACHE, 'screens')
MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTE = 'pyte==0.8.2'
# The id an installed copy of this mod has (name@marketplace): the session turns it off, so only
# the copy under test loads. Set COCKPIT_INSTALLED_ID if you installed it under another marketplace.
INSTALLED_ID = os.environ.get('COCKPIT_INSTALLED_ID', 'cockpit@local')


def ensure_pyte():
    """Runs this script again under the venv that holds pyte, made on the first run."""
    try:
        import pyte  # noqa: F401
        return
    except ImportError:
        pass
    python = os.path.join(VENV, 'bin', 'python')
    if os.path.abspath(sys.executable) == os.path.abspath(python):
        sys.exit(f'pyte could not be installed in {VENV}')
    if not os.path.exists(python):
        subprocess.run([sys.executable, '-m', 'venv', VENV], check=True)
    if subprocess.run([python, '-c', 'import pyte'], capture_output=True).returncode != 0:
        subprocess.run([python, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', PYTE], check=True)
    os.execv(python, [python, os.path.abspath(__file__), *sys.argv[1:]])


def make_last_prompt_two_part():
    """Splits the last typed prompt of the newest test conversation into two text parts.

    Once a conversation holds a message of several parts, Claude Code draws every later
    message under a derived id (the row id's first 24 characters, then the part's index), as
    in any long session: a feature keyed by message passes fresh tests and fails there."""
    files = sorted(glob.glob(os.path.join(HOME, '.claude', 'projects', '*cockpit-dev-work', '*.jsonl')),
                   key=os.path.getmtime)
    if not files:
        sys.exit('--two-part needs an earlier test conversation: run a prompt first')
    rows = [json.loads(line) for line in open(files[-1]) if line.strip()]
    prompts = [row for row in rows if row.get('type') == 'user' and isinstance((row.get('message') or {}).get('content'), str)
               and not row['message']['content'].startswith('<')]
    if not prompts:
        sys.exit('--two-part found no typed prompt in ' + files[-1])
    message = prompts[-1]['message']
    message['content'] = [{'type': 'text', 'text': message['content']}, {'type': 'text', 'text': '(second part)'}]
    with open(files[-1], 'w') as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('steps', nargs='+', help='prompts, /commands, or !shell commands, in order')
    parser.add_argument('--continue', dest='resume', action='store_true', help='resume the last test conversation')
    parser.add_argument('--two-part', action='store_true', help='split its last prompt in two parts first (implies --continue)')
    parser.add_argument('--model', default='haiku')
    parser.add_argument('--bin', default=os.path.join(HOME, '.local', 'bin', 'claude'), help='the Claude Code binary')
    parser.add_argument('--approve', action='store_true', help='approve permission questions instead of refusing them')
    parser.add_argument('--cols', type=int, default=200)
    parser.add_argument('--rows', type=int, default=50)
    args = parser.parse_args()

    import pyte

    class Screen(pyte.Screen):
        """Answers the terminal's queries (cursor position, device attributes) back to the app."""

        def __init__(self, cols, rows, master):
            super().__init__(cols, rows)
            self.master = master

        def write_process_input(self, data):
            os.write(self.master, data.encode())

    for folder in (WORK, SCREENS):
        os.makedirs(folder, exist_ok=True)
    subprocess.run(['rsync', '-a', '--delete', '--exclude', '.git', '--exclude', 'dev', '--exclude', '.claude',
                    MOD + '/', COPY + '/'], check=True)
    if args.two_part:
        make_last_prompt_two_part()

    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))
    env = {
        'HOME': HOME,
        'USER': os.environ.get('USER', ''),
        'LOGNAME': os.environ.get('LOGNAME', ''),
        'SHELL': '/bin/zsh',
        'PATH': os.path.join(HOME, '.local', 'bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
        'LANG': os.environ.get('LANG', 'en_US.UTF-8'),
        'TMPDIR': os.environ.get('TMPDIR', '/tmp'),
    }
    command = [
        args.bin,
        *(['--continue'] if args.resume or args.two_part else []),
        '--plugin-dir', COPY,
        '--settings', json.dumps({'enabledPlugins': {INSTALLED_ID: False}}),
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--model', args.model,
    ]
    child = subprocess.Popen(command, cwd=WORK, env=env, stdin=slave, stdout=slave, stderr=slave,
                             start_new_session=True, close_fds=True)
    os.close(slave)
    screen = Screen(args.cols, args.rows, master)
    stream = pyte.ByteStream(screen)
    dumps = os.path.join(SCREENS, time.strftime('%Y-%m-%d_%H-%M-%S') + '.txt')

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                stream.feed(data)
        return True

    def text():
        return '\n'.join(line.rstrip() for line in screen.display)

    def dump(label):
        with open(dumps, 'a') as out:
            out.write(f'\n===== {label} @ {time.strftime("%H:%M:%S")} =====\n{text()}\n')

    def send(data, pause=0.15):
        os.write(master, data)
        pump(pause)

    def settle(limit, is_done):
        """Waits until is_done(screen, seconds the screen has stayed still), refusing permission questions."""
        end = time.time() + limit
        last, still = '', 0.0
        while time.time() < end:
            if not pump(0.5):
                return
            now = text()
            if 'Do you want' in now:
                dump('permission question')
                send(b'\r' if args.approve else b'\x1b', 1.0)
                continue
            still = still + 0.5 if now == last else 0.0
            last = now
            if is_done(now, still):
                return
        print(f'[gave up waiting after {limit}s]')

    try:
        is_ready = lambda s: 'INSERT' in s or 'for shortcuts' in s or 'shift+tab' in s
        settle(90, lambda s, still: is_ready(s) or 'trust' in s.lower())
        if 'trust' in text().lower() and not is_ready(text()):
            # The test folder is ours: move to the option that trusts it (its place differs between
            # versions, "No, exit" may come first), then confirm.
            for _ in range(4):
                if 'Yes' in next((line for line in screen.display if '❯' in line), ''):
                    break
                send(b'\x1b[B', 0.5)
            send(b'\r', 1.0)
        settle(90, lambda s, still: is_ready(s) and still >= 2.0)
        dump('ready')
        for step in args.steps:
            if child.poll() is not None:
                print(f'[the session ended before the step: {step[:60]}]')
                break
            if step.startswith('!'):
                subprocess.run(step[1:], shell=True, check=True, cwd=MOD)
                dump(f'ran: {step[1:60]}')
                continue
            for char in step:
                send(char.encode(), 0.02)
            send(b'\r', 0.5)
            if step.startswith('/'):
                settle(240, lambda s, still: still >= 4.0)
            else:
                settle(300, lambda s, still: ('Done in' in s and still >= 3.0) or still >= 8.0)
            dump(f'after: {step[:60]}')
    finally:
        try:
            send(b'\x03', 0.3)
            send(b'\x03', 1.0)
        except OSError:
            pass
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass  # already gone
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        os.close(master)

    # The transcript side of the last screen: each line cut where the pane's border runs.
    lines = [line.rstrip() for line in screen.display]
    borders = [line.index('│', args.cols // 3) for line in lines if '│' in line[args.cols // 3:]]
    edge = max(set(borders), key=borders.count) if borders else args.cols
    print('\n'.join(line[:edge].rstrip() for line in lines).strip('\n'))
    print(f'\n[screens: {dumps}]')


if __name__ == '__main__':
    ensure_pyte()
    main()
