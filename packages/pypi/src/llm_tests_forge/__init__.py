"""Runs the llm-tests-forge binary that ships inside this platform's wheel."""

import os
import platform
import signal
import subprocess
import sys
from pathlib import Path

REPOSITORY_URL = "https://github.com/albertosca/llm-tests-forge"

# Python's spellings of an architecture, and the name the npm package and
# every other package give it (darwin-arm64, linux-x64, win32-x64).
ARCHITECTURE_NAMES = {
    "x86_64": "x64",
    "amd64": "x64",
    "arm64": "arm64",
    "aarch64": "arm64",
}


def binary_path() -> Path:
    name = "llm-tests-forge.exe" if sys.platform == "win32" else "llm-tests-forge"
    return Path(__file__).parent / "bin" / name


def platform_name(system_platform: str = sys.platform, machine: str = "") -> str:
    """This platform as the npm package names it: <sys.platform>-<architecture>."""
    architecture = (machine or platform.machine()).lower()
    return f"{system_platform}-{ARCHITECTURE_NAMES.get(architecture, architecture)}"


def missing_binary_message() -> str:
    return (
        f"llm-tests-forge has no binary for {platform_name()}; "
        f"see {REPOSITORY_URL} for install.sh"
    )


def run_attached(binary: str, arguments: list) -> int:
    """Runs the binary as a child and returns its exit status.

    The launcher stays attached through a Ctrl+C: a terminal sends it to the
    whole process group, and the binary decides what an interrupt means (the
    review saves on the first and aborts with 130 on the second). A child
    killed by a signal is reported the way a shell does, 128 plus the signal.
    """
    previous_handler = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        completed = subprocess.run([binary, *arguments])
    finally:
        signal.signal(signal.SIGINT, previous_handler)
    if completed.returncode < 0:
        return 128 - completed.returncode
    return completed.returncode


def main() -> None:
    binary = binary_path()
    if not binary.is_file():
        print(missing_binary_message(), file=sys.stderr)
        raise SystemExit(1)
    if sys.platform == "win32":
        # os.execv does not replace the process on Windows.
        raise SystemExit(run_attached(str(binary), sys.argv[1:]))
    # On Unix the process is replaced, so signals and the exit status are the binary's own.
    os.execv(str(binary), [str(binary), *sys.argv[1:]])
