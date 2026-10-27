#!/usr/bin/env python3
"""Build the local sandboxed file picker. Never opens UI or grants permissions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ID = "com.xiaoman.file-access"
EXECUTABLE = "xiaoman-file-access"
APP_NAME = "Xiaoman File Access.app"
LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
ENTITLEMENTS = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.files.user-selected.read-only": True,
    "com.apple.security.files.bookmarks.app-scope": True,
}
INFO = {
    "CFBundleIdentifier": BUNDLE_ID,
    "CFBundleName": "Xiaoman File Access",
    "CFBundleDisplayName": "小满文件授权",
    "CFBundleExecutable": EXECUTABLE,
    "CFBundlePackageType": "APPL",
    "CFBundleVersion": "1",
    "CFBundleShortVersionString": "1.0",
    "LSMinimumSystemVersion": "12.0",
    "NSHighResolutionCapable": True,
}


def run(command):
    subprocess.run(command, check=True, timeout=180, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def install(root=ROOT, identity="-"):
    if sys.platform != "darwin":
        raise ValueError("This helper must be installed on the paired Mac.")
    root = Path(root).resolve()
    source = root / "scripts/macos-file-access.swift"
    output = root / ".runtime/macos-file-access"
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.chmod(0o700)
    app = output / APP_NAME
    metadata_path = output / "installation.json"
    fingerprint = hashlib.sha256(source.read_bytes() + plistlib.dumps(INFO)
                                  + plistlib.dumps(ENTITLEMENTS) + identity.encode()).hexdigest()
    metadata = {"version": 1, "bundleID": BUNDLE_ID, "sourceHash": fingerprint,
                "signing": "ad-hoc-local" if identity == "-" else "configured-identity"}
    # Reinstalling unchanged source preserves the actual signed binary and its
    # sandbox/bookmark identity. A changed ad-hoc build may need user reauthorization.
    if metadata_path.is_file() and app.is_dir():
        cached = False
        try:
            if json.loads(metadata_path.read_text()) == metadata:
                run(["/usr/bin/codesign", "--verify", "--strict", str(app)])
                cached = True
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
        if cached:
            # A registration error must not cause a needless rebuild/re-sign.
            run([LSREGISTER, "-f", str(app)])
            return app / "Contents/MacOS" / EXECUTABLE
    with tempfile.TemporaryDirectory(prefix=".build-", dir=output) as temporary:
        staging = Path(temporary) / APP_NAME
        contents = staging / "Contents"
        binaries = contents / "MacOS"
        binaries.mkdir(parents=True)
        (contents / "Info.plist").write_bytes(plistlib.dumps(INFO))
        entitlements = Path(temporary) / "entitlements.plist"
        entitlements.write_bytes(plistlib.dumps(ENTITLEMENTS))
        binary = binaries / EXECUTABLE
        run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-O",
             "-framework", "AppKit", "-framework", "Security", str(source), "-o", str(binary)])
        binary.chmod(0o700)
        run(["/usr/bin/codesign", "--force", "--sign", identity, "--identifier", BUNDLE_ID,
             "--entitlements", str(entitlements), str(staging)])
        run(["/usr/bin/codesign", "--verify", "--strict", str(staging)])
        if app.exists():
            # Preserve the old signed app instead of silently destroying its identity.
            backup = output / f"previous-{time.time_ns()}.app"
            app.rename(backup)
        staging.rename(app)
    temporary_metadata = output / ".installation.tmp"
    temporary_metadata.write_text(json.dumps(metadata, indent=2) + "\n")
    temporary_metadata.chmod(0o600)
    os.replace(temporary_metadata, metadata_path)
    # Registration makes the fixed bundle identity discoverable without starting
    # its UI. Authorization still requires an explicit app command/user action.
    run([LSREGISTER, "-f", str(app)])
    return app / "Contents/MacOS" / EXECUTABLE


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sign-identity", default="-",
                        help="Optional existing Apple code-signing identity; default is local ad-hoc signing.")
    arguments = parser.parse_args()
    try:
        install(identity=arguments.sign_identity)
        print(json.dumps({"installed": True, "bundleID": BUNDLE_ID, "sandboxed": True,
                          "authorizationStarted": False}))
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit("Native file authorization helper build failed. Install Xcode Command Line Tools and check code signing; no permissions were changed.")
