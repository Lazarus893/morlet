"""Companion APK interface for phone automation agent.

Provides a high-level interface to interact with the Android companion APK
(com.agent.helper), which supports dialogs, screen overlay control, and
utility commands via ADB broadcasts.
"""

import json
import logging
import shlex
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

PACKAGE = "com.agent.helper"
RESPONSE_PATH = f"/sdcard/Android/data/{PACKAGE}/files/response.json"


@dataclass
class CompanionResponse:
    """Response from the companion APK."""

    type: str
    result: str
    timestamp: int
    raw: dict


class CompanionError(Exception):
    """Base exception for companion APK errors."""


class CompanionClient:
    """Interface to the Android companion APK for dialogs and overlay control.

    Communicates with the companion APK installed on the device via ADB shell
    commands, broadcasts, and activity intents. Supports:
    - Dialogs (yes/no, text input, info)
    - Screen protection overlay
    - Ping / health check

    Example:
        >>> client = CompanionClient(device_id="emulator-5554")
        >>> client.setup()
        >>> approved = client.ask_yesno("Confirm", "Proceed with operation?")
        >>> if approved:
        ...     client.notify("Status", "Operation started")
    """

    def __init__(
        self, device_id: str | None = None, apk_path: str | None = None
    ) -> None:
        """
        Initialize the companion client.

        Args:
            device_id: ADB device serial (for multi-device). None = default device.
            apk_path: Path to the companion APK file for auto-install.
        """
        self.device_id = device_id
        self.apk_path = apk_path
        self._overlay_active = False

    # --- Core ADB helpers ---

    def _get_adb_prefix(self) -> list[str]:
        """Get ADB command prefix with optional device specifier."""
        if self.device_id:
            return ["adb", "-s", self.device_id]
        return ["adb"]

    def _adb(self, *args: str, timeout: int = 10) -> str:
        """
        Run an ADB command and return stdout.

        Args:
            *args: ADB command arguments (e.g., "install", "-r", path).
            timeout: Command timeout in seconds.

        Returns:
            Stripped stdout output.

        Raises:
            CompanionError: If the command fails or times out.
        """
        cmd = self._get_adb_prefix() + list(args)
        logger.debug("Running ADB command: %s", cmd)
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=timeout,
            )
            output = result.stdout.strip()
            if result.returncode != 0:
                stderr = result.stderr.strip()
                logger.warning(
                    "ADB command returned %d: %s", result.returncode, stderr
                )
            return output
        except subprocess.TimeoutExpired:
            logger.error("ADB command timed out after %ds: %s", timeout, cmd)
            raise CompanionError(f"ADB command timed out after {timeout}s: {cmd}")
        except FileNotFoundError:
            raise CompanionError("ADB executable not found in PATH")

    def _adb_shell(self, *args: str, timeout: int = 10) -> str:
        """
        Run an ADB shell command with proper argument escaping.

        Shell arguments containing spaces or special characters are quoted
        so they arrive intact on the device.

        Args:
            *args: Shell command arguments.
            timeout: Command timeout in seconds.

        Returns:
            Stripped stdout output.
        """
        # Each argument is individually shell-quoted so that the device-side
        # shell interprets it as a single token.  This is critical for
        # ``am start --es`` extras that may contain spaces or punctuation.
        escaped = " ".join(shlex.quote(a) for a in args)
        return self._adb("shell", escaped, timeout=timeout)

    # --- Installation & Setup ---

    def is_installed(self) -> bool:
        """Check if companion APK is installed on the device."""
        output = self._adb_shell("pm", "list", "packages", PACKAGE)
        installed = PACKAGE in output
        logger.debug("Companion APK installed: %s", installed)
        return installed

    def install(self, apk_path: str | None = None) -> bool:
        """
        Install the companion APK.

        Args:
            apk_path: Override APK path. Falls back to ``self.apk_path``.

        Returns:
            True on success.

        Raises:
            ValueError: If no APK path is provided.
            CompanionError: If installation fails.
        """
        path = apk_path or self.apk_path
        if not path:
            raise ValueError("No APK path provided")

        logger.info("Installing companion APK from %s", path)
        output = self._adb("install", "-r", "-g", path, timeout=60)
        success = "Success" in output
        if not success:
            raise CompanionError(f"APK installation failed: {output}")
        logger.info("Companion APK installed successfully")
        return True

    def ensure_installed(self) -> None:
        """Install APK if not already installed."""
        if not self.is_installed():
            self.install()

    def grant_permissions(self) -> None:
        """Grant all required runtime permissions via ADB.

        Note: On some devices (e.g., ColorOS/OPPO), `appops set` requires root.
        In that case the overlay permission must be granted manually via system
        settings. This method logs a warning instead of raising an error.
        """
        logger.info("Granting overlay permission to %s", PACKAGE)
        output = self._adb_shell(
            "appops", "set", PACKAGE, "SYSTEM_ALERT_WINDOW", "allow"
        )
        if "SecurityException" in output or "permission" in output.lower():
            logger.warning(
                "Could not grant overlay permission via ADB (device restriction). "
                "Please grant it manually: Settings → Apps → %s → Display over other apps",
                PACKAGE,
            )

    def setup(self) -> None:
        """Full setup: install if missing and grant permissions."""
        self.ensure_installed()
        self.grant_permissions()
        logger.info("Companion APK setup complete")

    # --- Response handling ---

    def _clear_response(self) -> None:
        """Clear the response file on device."""
        self._adb_shell("rm", "-f", RESPONSE_PATH)

    def _read_response(
        self, timeout: float = 30.0, poll_interval: float = 0.5
    ) -> CompanionResponse | None:
        """
        Poll the device for a response from the companion app.

        Args:
            timeout: Maximum seconds to wait for a response.
            poll_interval: Seconds between poll attempts.

        Returns:
            CompanionResponse or None if timed out.
        """
        start = time.time()
        while time.time() - start < timeout:
            try:
                output = self._adb_shell("cat", RESPONSE_PATH)
            except CompanionError:
                # ADB failure during polling — wait and retry
                time.sleep(poll_interval)
                continue

            if output and not output.startswith("cat:"):
                try:
                    data = json.loads(output)
                    logger.debug("Received companion response: %s", data)
                    return CompanionResponse(
                        type=data.get("type", ""),
                        result=data.get("result", ""),
                        timestamp=data.get("timestamp", 0),
                        raw=data,
                    )
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON in response file: %s", output)
            time.sleep(poll_interval)

        logger.warning("Timed out waiting for companion response after %.1fs", timeout)
        return None

    # --- Dialog API ---

    def show_dialog(
        self,
        title: str,
        message: str,
        dialog_type: str = "yesno",
        timeout: float = 60.0,
    ) -> CompanionResponse | None:
        """
        Show a dialog on the phone and wait for user response.

        Args:
            title: Dialog title.
            message: Dialog message body.
            dialog_type: One of ``"yesno"``, ``"text_input"``, or ``"info"``.
            timeout: Max seconds to wait for response.

        Returns:
            CompanionResponse or None if timed out.
        """
        logger.info(
            "Showing %s dialog: title=%r message=%r", dialog_type, title, message
        )
        self._clear_response()
        self._adb_shell(
            "am",
            "start",
            "-n",
            f"{PACKAGE}/.DialogActivity",
            "--es",
            "title",
            title,
            "--es",
            "message",
            message,
            "--es",
            "type",
            dialog_type,
        )

        if dialog_type == "info":
            return CompanionResponse(
                type="info",
                result="ok",
                timestamp=int(time.time()),
                raw={},
            )
        return self._read_response(timeout=timeout)

    def ask_yesno(
        self, title: str, message: str, timeout: float = 60.0
    ) -> bool | None:
        """
        Show a Yes/No dialog.

        Args:
            title: Dialog title.
            message: Dialog message body.
            timeout: Max seconds to wait for response.

        Returns:
            True if user confirmed, False if declined, None if timed out.
        """
        resp = self.show_dialog(title, message, "yesno", timeout)
        if resp is None:
            return None
        return resp.result.lower() in ("yes", "true", "确认", "是")

    def ask_text(
        self, title: str, message: str, timeout: float = 120.0
    ) -> str | None:
        """
        Show a text input dialog.

        Args:
            title: Dialog title.
            message: Dialog message / prompt.
            timeout: Max seconds to wait for response.

        Returns:
            User-entered text or None if timed out.
        """
        resp = self.show_dialog(title, message, "text_input", timeout)
        return resp.result if resp else None

    def notify(self, title: str, message: str) -> None:
        """Show an informational dialog (fire-and-forget, no response needed)."""
        self.show_dialog(title, message, "info")

    # --- Overlay API ---

    def overlay_on(self) -> None:
        """Enable the screen protection overlay."""
        logger.debug("Enabling screen overlay")
        self._adb_shell(
            "am",
            "broadcast",
            "-n",
            f"{PACKAGE}/.OverlayReceiver",
            "-a",
            f"{PACKAGE}.OVERLAY_ON",
        )
        self._overlay_active = True

    def overlay_off(self) -> None:
        """Disable the screen protection overlay."""
        logger.debug("Disabling screen overlay")
        self._adb_shell(
            "am",
            "broadcast",
            "-n",
            f"{PACKAGE}/.OverlayReceiver",
            "-a",
            f"{PACKAGE}.OVERLAY_OFF",
        )
        self._overlay_active = False

    @property
    def overlay_active(self) -> bool:
        """Whether the overlay is currently believed to be active."""
        return self._overlay_active

    def screenshot_with_overlay(self, screenshot_func: Callable[[], Any]) -> Any:
        """
        Take a screenshot with the overlay temporarily hidden.

        This is the key integration point: wraps any screenshot callable with
        overlay hide/show so the captured image is clean.

        Args:
            screenshot_func: Callable that takes no args and returns a screenshot.

        Returns:
            The screenshot result from *screenshot_func*.
        """
        if not self._overlay_active:
            return screenshot_func()

        try:
            self.overlay_off()
            time.sleep(0.15)  # Wait for overlay animation to finish
            result = screenshot_func()
            return result
        finally:
            self.overlay_on()

    # --- Utility ---

    def ping(self) -> bool:
        """
        Check if the companion APK is responsive.

        Sends a ``ping`` command broadcast and expects a ``pong`` response.

        Returns:
            True if the companion responded with ``pong``.
        """
        logger.debug("Pinging companion APK")
        self._clear_response()
        self._adb_shell(
            "am",
            "broadcast",
            "-n",
            f"{PACKAGE}/.CommandReceiver",
            "-a",
            f"{PACKAGE}.COMMAND",
            "--es",
            "cmd",
            "ping",
        )
        resp = self._read_response(timeout=5.0)
        alive = resp is not None and resp.result == "pong"
        logger.debug("Companion APK ping result: %s", alive)
        return alive
