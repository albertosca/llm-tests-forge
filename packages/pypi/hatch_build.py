"""Build hook: one wheel per platform, carrying that platform's binary.

Both environment variables are required:
  FORGE_WHEEL_PLATFORM  the platform part of the wheel tag, e.g. macosx_11_0_arm64
  FORGE_WHEEL_BINARY    the path of the compiled binary to ship
"""

import os
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def required_variable(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set: this package ships one platform's binary per wheel, "
            "build it with scripts/release/wheels.ts"
        )
    return value


class PlatformBinaryHook(BuildHookInterface):
    def initialize(self, version, build_data):
        platform_tag = required_variable("FORGE_WHEEL_PLATFORM")
        # The build runs in this package's directory, not the caller's, so a
        # relative path would name a different file than the caller meant.
        binary = Path(required_variable("FORGE_WHEEL_BINARY"))
        if not binary.is_absolute():
            raise RuntimeError(f"FORGE_WHEEL_BINARY must be an absolute path: {binary}")
        if not binary.is_file():
            raise RuntimeError(f"FORGE_WHEEL_BINARY does not exist: {binary}")
        # The repository's LICENSE, two levels above this package (packages/pypi).
        license_file = Path(self.root).resolve().parents[1] / "LICENSE"
        if not license_file.is_file():
            raise RuntimeError(
                f"the LICENSE every package ships is missing: {license_file}"
            )
        build_data["pure_python"] = False
        build_data["tag"] = "py3-none-" + platform_tag
        suffix = ".exe" if binary.suffix == ".exe" else ""
        build_data["force_include"][str(binary)] = (
            f"llm_tests_forge/bin/llm-tests-forge{suffix}"
        )
        build_data["force_include"][str(license_file)] = "llm_tests_forge/LICENSE"
