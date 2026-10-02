"""Open the installed plugin's menus in a real OpenCode terminal without sending a prompt."""

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


binary, project = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(project)
    os.execvpe(binary, [binary, "--port", "0"], os.environ)

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
transcript = bytearray()
escape = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


def screen():
    return escape.sub("", transcript.decode("utf-8", errors="replace"))


def wait_for(*labels, retry_input=None):
    # Each checkpoint must appear in new terminal output, not a prior menu's text.
    start = len(transcript)
    deadline = time.monotonic() + 40
    next_input = 0
    while time.monotonic() < deadline:
        if retry_input is not None and time.monotonic() >= next_input:
            # A restored dialog can render before its deferred input focus runs.
            # Retry only an idempotent clear-and-type probe, never Enter.
            os.write(terminal, retry_input)
            next_input = time.monotonic() + 0.1
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


def command(name, label):
    os.write(terminal, name.encode())
    wait_for(name, label)
    os.write(terminal, b"\r")


def filter_menu(query, label):
    # A menu label alone does not prove that its search input is focused. Make
    # the host process a nonmatching query first; this also removes every old
    # option from the screen, so the next checkpoint proves filtering finished.
    wait_for("No results found", retry_input=b"\x15zz-composer-focus-probe")
    os.write(terminal, b"\x15" + query.encode())
    wait_for(label)
    os.write(terminal, b"\r")


try:
    wait_for("Ask anything")
    command("/compose", "Compose configuration")
    wait_for("Compose", "Effective configuration and sources")
    os.write(terminal, b"\r")
    wait_for("Effective configuration and sources", "Running native defaults")
    os.write(terminal, b"\r")
    wait_for("Pointer: /model", "source file unavailable")
    os.write(terminal, b"\x1b")
    wait_for("Effective configuration and sources", "Running native defaults")
    os.write(terminal, b"\x1b")
    wait_for("Compose", "Agent models")
    for _ in range(3):
        filter_menu("models", "Agent models")
        wait_for("Agent models: scope", "Global defaults")
        os.write(terminal, b"\x1b")
        wait_for("Compose", "Agent models")
        filter_menu("groups", "Agent groups")
        wait_for("Agent groups", "Create a new group")
        os.write(terminal, b"\x1b")
        wait_for("Compose", "Agent groups")
    os.write(terminal, b"\x1b")
    wait_for("Ask anything")
    print("native TUI rendered compose inspection and nested navigation")
    command("/agent-models", "Agent models")
    wait_for("Agent models: scope", "Global defaults")
    os.write(terminal, b"\x1b")
    wait_for("Ask anything")
    command("/agent-groups", "Agent groups")
    wait_for("Agent groups", "Create a new group")
    print("native TUI rendered both Composer menus")
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
