"""WDA transport: validate HTTP/protocol errors and bypass unrelated proxy settings."""
import requests


def request(method, url, **kwargs):
    kwargs.pop("verify", None)
    with requests.Session() as session:
        session.trust_env = False
        response = session.request(method, url, verify=True, **kwargs)
    response.raise_for_status()
    data = response.json()
    value = data.get("value")
    if data.get("status", 0) not in (0, None) or isinstance(value, dict) and value.get("error"):
        raise RuntimeError("WebDriverAgent rejected the operation")
    return response


def get(url, **kwargs):
    return request("GET", url, **kwargs)


def post(url, **kwargs):
    return request("POST", url, **kwargs)
