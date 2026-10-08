"""Project-local paths shared by the Python entry points."""
import os
import shutil
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
DSH_HOME = Path(os.environ.get("DSH_HOME", str(RUNTIME / "dsh")))
PROFILE_DIR = DSH_HOME / "profiles/wx-life"
WORKSPACE = RUNTIME / "workspace"
PHONE_PROFILE = RUNTIME / "phone.json"
AUTO_PHONE = ROOT / "vendor/auto-phone"
ADB = os.environ.get("ADB", shutil.which("adb") or "adb")
PORT = int(os.environ.get("XIAOMAN_PORT", "3082"))


def control_socket(root=ROOT):
    # Unix socket names are short even when a checkout has a deeply nested path.
    identity = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:12]
    return Path("/tmp") / f"xiaoman-{os.getuid()}-{identity}.sock"


CONTROL_SOCKET = control_socket()

if __name__ == "__main__":
    print(CONTROL_SOCKET)
