"""Screenshot utilities for capturing iOS device screen."""

import base64
from dataclasses import dataclass
from io import BytesIO

from PIL import Image


@dataclass
class Screenshot:
    """Represents a captured screenshot."""

    base64_data: str
    width: int
    height: int
    is_sensitive: bool = False


def get_screenshot(
    wda_url: str = "http://localhost:8100",
    session_id: str | None = None,
    device_id: str | None = None,
    timeout: int = 10,
) -> Screenshot:
    """
    Capture a screenshot from the connected iOS device.

    Args:
        wda_url: WebDriverAgent URL.
        session_id: Optional WDA session ID.
        device_id: Optional device identifier retained in task configuration.
        timeout: Timeout in seconds for screenshot operations.

    Returns:
        Screenshot object containing base64 data and dimensions.

    Note:
        Captures only the configured WebDriverAgent endpoint.
        If capture fails, stop the task; never feed a synthetic screen to the model.
    """
    # Try WebDriverAgent first (preferred method)
    screenshot = _get_screenshot_wda(wda_url, session_id, timeout)
    if screenshot:
        return screenshot

    raise RuntimeError("WDA screenshot unavailable; device task stopped")


def _get_screenshot_wda(
    wda_url: str, session_id: str | None, timeout: int
) -> Screenshot | None:
    """
    Capture screenshot using WebDriverAgent.

    Args:
        wda_url: WebDriverAgent URL.
        session_id: Optional WDA session ID.
        timeout: Timeout in seconds.

    Returns:
        Screenshot object or None if failed.
    """
    try:
        from phone_agent.xctest import http as requests

        url = f"{wda_url.rstrip('/')}/screenshot"

        response = requests.get(url, timeout=timeout)

        if response.status_code == 200:
            data = response.json()
            base64_data = data.get("value", "")

            if base64_data:
                # Decode to get dimensions
                img_data = base64.b64decode(base64_data)
                img = Image.open(BytesIO(img_data))
                width, height = img.size

                return Screenshot(
                    base64_data=base64_data,
                    width=width,
                    height=height,
                    is_sensitive=False,
                )

    except ImportError:
        print("Note: requests library not installed. Install: pip install requests")
    except Exception as e:
        print(f"WDA screenshot failed: {e}")

    return None


def save_screenshot(
    screenshot: Screenshot,
    file_path: str,
) -> bool:
    """
    Save a screenshot to a file.

    Args:
        screenshot: Screenshot object.
        file_path: Path to save the screenshot.

    Returns:
        True if successful, False otherwise.
    """
    try:
        img_data = base64.b64decode(screenshot.base64_data)
        img = Image.open(BytesIO(img_data))
        img.save(file_path)
        return True
    except Exception as e:
        print(f"Error saving screenshot: {e}")
        return False


def get_screenshot_png(
    wda_url: str = "http://localhost:8100",
    session_id: str | None = None,
    device_id: str | None = None,
) -> bytes | None:
    """
    Get screenshot as PNG bytes.

    Args:
        wda_url: WebDriverAgent URL.
        session_id: Optional WDA session ID.
        device_id: Optional device UDID.

    Returns:
        PNG bytes or None if failed.
    """
    screenshot = get_screenshot(wda_url, session_id, device_id)

    try:
        return base64.b64decode(screenshot.base64_data)
    except Exception:
        return None
