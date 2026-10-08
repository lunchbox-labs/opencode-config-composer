"""Exercise profile action registration, scoped save and apply in native OpenCode."""

import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


binary, project = sys.argv[1:3]
availability = len(sys.argv) > 3 and sys.argv[3] == 'availability'
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(project)
    os.execvpe(binary, [binary, "--port", "0"], os.environ)

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
transcript = bytearray()
escape = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


def screen():
    return escape.sub("", transcript.decode("utf-8", errors="replace"))


def wait_for(*labels, timeout=40):
    # Each checkpoint must appear in new terminal output, not a prior menu's text.
    start = len(transcript)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([terminal], [], [], 0.1)
        if not ready:
            continue
        try:
            data = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise AssertionError("OpenCode exited before the terminal checkpoint") from error
            raise
        if not data:
            raise AssertionError("OpenCode closed the terminal before the checkpoint")
        transcript.extend(data)
        for query, response in [
            (b"\x1b[6n", b"\x1b[1;1R"),
            (b"\x1b[c", b"\x1b[?1;2c"),
            (b"\x1b[>c", b"\x1b[>0;95;0c"),
            (b"\x1b[?u", b"\x1b[?0u"),
        ]:
            if query in data:
                os.write(terminal, response)
        current = escape.sub("", transcript[start:].decode("utf-8", errors="replace"))
        if all(label in current for label in labels):
            return
    raise AssertionError(f"Terminal did not render {labels}")


def filter_menu(value):
    # A newly painted menu can precede input focus. Require echoed input before Enter.
    for attempt in range(3):
        os.write(terminal, b"\x15" + value.encode())
        try:
            wait_for(value, timeout=2)
            return
        except AssertionError:
            if attempt == 2:
                raise


def command(name, label):
    os.write(terminal, name.encode())
    wait_for(name, label)
    os.write(terminal, b"\r")


def activate(name, description, profiles, agent=None):
    command('/' + name, description)
    wait_for('/' + name + ': save profile selection in', "local", "shared")
    filter_menu("local")
    os.write(terminal, b"\r")
    wait_for('Shortcut /' + name + ': ' + profiles, "Destination: local", "Confirm")
    os.write(terminal, b"\r")
    wait_for("Saved Composer revision", "pending")
    filter_menu("Reload now")
    os.write(terminal, b"\r")
    wait_for("Apply saved revision?", "only this instance")
    os.write(terminal, b"\r")
    wait_for(*(["Composer revision applied", agent] if agent else ["Composer revision applied"]))


try:
    wait_for(*(["Ask anything", "Build"] if availability else ["Ask anything"]))
    if availability:
        activate('planning', 'Select planning agents', 'planning', 'Plan')
    activate('quiet', 'Select no profiles', 'none', 'Build' if availability else None)
    print("native TUI saved and applied profile shortcut without a model request")
except BaseException:
    print(" ".join(screen().split())[-6000:], file=sys.stderr)
    raise
finally:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        finished, _ = os.waitpid(pid, os.WNOHANG)
        if finished:
            break
        time.sleep(0.05)
    else:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
