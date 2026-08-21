"""Streaming smoke test against the live Relaybee router.

Fires a batch of ASCII-art / ASCII-chart prompts and streams each answer to the
terminal, then prints timing and token-ish stats per hit.

    python test_ascii_art.py            # run all prompts
    python test_ascii_art.py 0 3        # run only prompts 0 and 3
"""

import sys
import time

from openai import OpenAI

BASE_URL = "https://relaybee.vercel.app/api/v1"
API_KEY = "fo_live_eyJ1IjoiYW5vbl84NzlkZTIwYSIsInQiOiJmcmVlIiwidiI6MSwiaSI6MTc4NTYzODYxNCwiZSI6MTc5MzQxNDYxNH0.zcwXYPGuCgpsZlMTAH2EVdrycwTS1JZGtuGsNtwa46s"
MODEL = "claude-code"

SYSTEM = (
    "You are an ASCII artist. Reply with ONLY the ASCII art or ASCII chart itself "
    "inside a plain code block, no explanation before or after. Use monospace-safe "
    "characters, keep every line under 78 columns, and make it genuinely good, not "
    "a lazy 5-line sketch."
)

PROMPTS = [
    "Draw a detailed ASCII art cat sitting on a windowsill at night, with a moon outside.",
    "Draw an ASCII bar chart of the top 6 programming languages by GitHub stars, "
    "with axis labels, value labels at the end of each bar, and a title.",
    "Draw an ASCII line graph (using / \\ _ and .) of a sine wave over two full "
    "periods, with a labeled x-axis and y-axis.",
    "Draw a big ASCII banner that reads RELAYBEE in block letters, then under it a "
    "small ASCII bee.",
    "Draw an ASCII architecture diagram of an API gateway: clients on the left, a "
    "router box in the middle, three upstream model providers on the right, with "
    "arrows and box borders.",
    "Draw an ASCII sparkline dashboard: three labeled metric rows (requests, "
    "latency, errors) each with a 40-char sparkline and a current value.",
]


def run(client, index, prompt):
    print(f"\n{'=' * 78}\n[{index}] {prompt}\n{'-' * 78}")

    start = time.time()
    first_token_at = None
    chunks = 0
    out = []

    stream = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        stream=True,
    )

    for part in stream:
        if not part.choices:
            continue
        text = part.choices[0].delta.content or ""
        if text:
            if first_token_at is None:
                first_token_at = time.time() - start
            chunks += 1
            out.append(text)
            print(text, end="", flush=True)

    total = time.time() - start
    body = "".join(out)
    ttft = f"{first_token_at:.2f}s" if first_token_at is not None else "never"
    print(
        f"\n{'-' * 78}\n"
        f"chars={len(body)} lines={body.count(chr(10)) + 1} chunks={chunks} "
        f"ttft={ttft} total={total:.2f}s"
    )
    return first_token_at is not None


def main():
    picks = [int(a) for a in sys.argv[1:]] or list(range(len(PROMPTS)))
    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)

    passed = 0
    for i in picks:
        try:
            if run(client, i, PROMPTS[i]):
                passed += 1
            else:
                print(f"[{i}] FAIL: stream produced no content")
        except Exception as exc:
            print(f"\n[{i}] FAIL: {type(exc).__name__}: {exc}")

    print(f"\n{'=' * 78}\n{passed}/{len(picks)} prompts streamed content")
    return 0 if passed == len(picks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
