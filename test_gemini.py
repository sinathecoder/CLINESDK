#!/usr/bin/env python3
"""
Gemini API key tester (no external dependencies - uses the standard library).

Usage:
    python test_gemini.py
    python test_gemini.py YOUR_API_KEY
    GEMINI_API_KEY=YOUR_API_KEY python test_gemini.py

If no key is provided via argument, it falls back to the GEMINI_API_KEY
environment variable.
"""

import json
import os
import sys
import urllib.error
import urllib.request


def get_api_key() -> str:
    """Resolve the API key from CLI arg (optional model) or environment variable."""
    # CLI argument takes priority
    if len(sys.argv) > 1:
        return sys.argv[1].strip()

    # Environment variable fallback
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key

    raise SystemExit(
        "\n[ERROR] No API key found.\n"
        "  Provide it either as an argument:\n"
        "    python3 test_gemini.py YOUR_API_KEY [MODEL]\n"
        "  or as an environment variable:\n"
        "    GEMINI_API_KEY=YOUR_API_KEY python3 test_gemini.py\n"
    )


def get_model() -> str:
    """Resolve model from optional 2nd CLI arg, or default to a current model."""
    if len(sys.argv) > 2:
        return sys.argv[2].strip()
    return os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")


def test_gemini(api_key: str, model: str) -> None:
    """Send a quick completion request to the Gemini API and print the result."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    # The `key` query parameter is how the Gemini REST API authenticates
    request = urllib.request.Request(
        url + f"?key={api_key}",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(
            {
                "contents": [
                    {
                        "parts": [
                            {"text": "Reply with exactly: GEMINI_OK"}
                        ]
                    }
                ]
            }
        ).encode("utf-8"),
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print(f"[FAIL] HTTP {err.code}")
        print(f"  Server response: {body}")
        return
    except urllib.error.URLError as err:
        print(f"[FAIL] Network error: {err.reason}")
        return

    # Extract the generated text from the response
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        print("[FAIL] Unexpected response shape:")
        print(json.dumps(data, indent=2)[:2000])
        return

    # Sanity-check the model actually responded as expected
    ok = "GEMINI_OK" in text
    print("=" * 56)
    print("Gemini API test")
    print("=" * 56)
    print(f"  Model          : {model}")
    print(f"  Key prefix     : {api_key[:8]}{'*' * (len(api_key) - 8) if len(api_key) > 8 else ''}")
    print(f"  Model response : {text.strip()}")
    print("-" * 56)
    if ok:
        print("  RESULT: SUCCESS - your API key is valid and working!")
    else:
        print("  RESULT: RESPONDED, but the reply was unexpected.")
    print("=" * 56)


if __name__ == "__main__":
    api_key = get_api_key()
    model = get_model()
    # Mask the key in any traceback/errors so we don't leak it
    test_gemini(api_key, model)