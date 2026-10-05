"""Runs the llm-tests-forge binary that ships inside this platform's wheel.

The fallback wheel (py3-none-any), which an installer chooses only where no
platform wheel fits, ships no binary: its entry names the platform and points
at install.sh.
"""

import glob
import os
import platform
import signal
import subprocess
import sys
from importlib import metadata
from pathlib import Path

REPOSITORY_URL = "https://github.com/albertosca/llm-tests-forge"

# Python's spellings of an architecture, and the name the npm package and
# every other package give it (darwin-arm64, linux-x64, win32-x64). Every
# 32-bit x86 spelling is npm's ia32.
ARCHITECTURE_NAMES = {
    "x86_64": "x64",
    "amd64": "x64",
    "arm64": "arm64",
    "aarch64": "arm64",
    "x86": "ia32",
    "i386": "ia32",
    "i486": "ia32",
    "i586": "ia32",
    "i686": "ia32",
}

# Each platform a release wheel is built for, as platform_name() names it, and
# that wheel's platform tag, in the order of scripts/release/targets.ts; the
# package tests check the two agree.
PLATFORM_WHEEL_TAGS = {
    "darwin-arm64": "macosx_11_0_arm64",
    "darwin-x64": "macosx_10_12_x86_64",
    "linux-x64": "manylinux_2_17_x86_64",
    "linux-arm64": "manylinux_2_17_aarch64",
    "win32-x64": "win_amd64",
}


def binary_path() -> Path:
    name = "llm-tests-forge.exe" if sys.platform == "win32" else "llm-tests-forge"
    return Path(__file__).parent / "bin" / name


def platform_name(system_platform: str = sys.platform, machine: str = "") -> str:
    """This platform as the npm package names it: <sys.platform>-<architecture>."""
    architecture = (machine or platform.machine()).lower()
    return f"{system_platform}-{ARCHITECTURE_NAMES.get(architecture, architecture)}"


def libc_family(libc_name=None, musl_loader_paths=None) -> str:
    """The C library of this Linux: glibc, musl, or unknown.

    platform.libc_ver() names glibc; musl is named by it on some Pythons and
    otherwise found by its dynamic loader, /lib/ld-musl-<cpu>.so.1.
    """
    if libc_name is None:
        libc_name = platform.libc_ver()[0]
    if libc_name == "glibc":
        return "glibc"
    if musl_loader_paths is None:
        musl_loader_paths = glob.glob("/lib/ld-musl-*")
    if libc_name == "musl" or musl_loader_paths:
        return "musl"
    return "unknown"


def is_fallback_wheel() -> bool:
    """Whether the installed llm-tests-forge is the py3-none-any fallback wheel."""
    try:
        wheel = metadata.distribution("llm-tests-forge").read_text("WHEEL") or ""
    except metadata.PackageNotFoundError:
        return False
    return "Tag: py3-none-any" in wheel.splitlines()


def missing_binary_message(
    system_platform: str = sys.platform, machine: str = "", libc=None, fallback=None
) -> str:
    """What the entry says when no binary runs here.

    musl Linux has no binary yet (the Linux ones need glibc). The fallback
    wheel on a platform that has a platform wheel was chosen because an
    installer was asked for another platform. Anywhere else the platform has
    no binary, and install.sh is the way.
    """
    name = platform_name(system_platform, machine)
    if system_platform == "linux":
        libc = libc or libc_family()
        if libc == "musl":
            return (
                f"llm-tests-forge has no binary for musl/Alpine yet ({name}-musl): "
                f"the {name} binary needs glibc; see {REPOSITORY_URL}"
            )
    if fallback is None:
        fallback = is_fallback_wheel()
    platform_tag = PLATFORM_WHEEL_TAGS.get(name)
    supported = platform_tag is not None and (
        system_platform != "linux" or libc == "glibc"
    )
    if fallback and supported:
        return (
            "llm-tests-forge: this is the py3-none-any fallback wheel, which has no "
            f"binary, but {name} has a platform wheel ({platform_tag}); the installer "
            "was asked for another platform (pip --platform, uv --python-platform) "
            "and chose the fallback. Let the installer pick (pip install "
            f"llm-tests-forge), or ask for that wheel with --platform {platform_tag}"
        )
    return (
        f"llm-tests-forge has no binary for {name}; see {REPOSITORY_URL} for install.sh"
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
