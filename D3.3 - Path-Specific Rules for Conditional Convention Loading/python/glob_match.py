"""A small, dependency-free path glob matcher (the syntax `paths:` frontmatter uses).

    **      any number of directories, including none, when it is a whole path segment:
            "terraform/**/*" matches terraform/main.tf AND terraform/modules/network/main.tf
            "**/*.test.tsx"  matches Button.test.tsx at the root AND src/components/forms/X.test.tsx
    *       any characters except "/" (stays inside one path segment)
    ?       exactly one character except "/"
    {a,b}   alternation, may nest: "src/**/*.{ts,tsx}"
    [abc]   character class; [!abc] negates

Paths are matched relative to the project root, with forward slashes.
"""

from __future__ import annotations

import re
from functools import lru_cache


def expand_braces(pattern: str) -> list[str]:
    """`src/*.{ts,tsx}` -> [`src/*.ts`, `src/*.tsx`]. Expanding first keeps `**` handling simple."""
    depth, start = 0, -1
    for i, ch in enumerate(pattern):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                options, level, current = [], 0, ""
                for c in pattern[start + 1 : i]:
                    if c == "," and level == 0:
                        options.append(current)
                        current = ""
                        continue
                    level += (c == "{") - (c == "}")
                    current += c
                options.append(current)
                if len(options) < 2:
                    return [pattern]  # "{a}" is not an alternation; treat the braces literally
                head, tail = pattern[:start], pattern[i + 1 :]
                return [expanded for option in options for expanded in expand_braces(head + option + tail)]
    return [pattern]


def _translate(pattern: str) -> str:
    """One brace-free glob -> an anchored regular expression."""
    out, i, n = [], 0, len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if pattern.startswith("**", i):
                segment_start = i == 0 or pattern[i - 1] == "/"
                after = i + 2
                if segment_start and after < n and pattern[after] == "/":
                    out.append("(?:.*/)?")  # "**/" = zero or more whole directories
                    i = after + 1
                    continue
                out.append(".*")  # trailing "/**" or "**" glued to text: anything, across "/"
                i = after
                continue
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        elif ch == "[":
            close = pattern.find("]", i + 1)
            if close == -1:
                out.append(re.escape(ch))
            else:
                body = pattern[i + 1 : close]
                negate = body.startswith("!")
                body = body[1:] if negate else body
                out.append(("[^" if negate else "[") + body.replace("\\", "\\\\") + "]")
                i = close
        else:
            out.append(re.escape(ch))
        i += 1
    return "".join(out)


@lru_cache(maxsize=512)
def compile_glob(pattern: str) -> re.Pattern[str]:
    return re.compile("^(?:" + "|".join(_translate(p) for p in expand_braces(pattern)) + ")$")


def glob_match(pattern: str, path: str) -> bool:
    """True when the project-relative `path` matches the glob `pattern`."""
    pattern = pattern[2:] if pattern.startswith("./") else pattern  # "./src/**" means "src/**"
    return compile_glob(pattern).match(path.replace("\\", "/")) is not None


# (pattern, path, expected) - run by rule_loader.py as a self-test
SELF_TEST: list[tuple[str, str, bool]] = [
    ("terraform/**/*", "terraform/main.tf", True),
    ("terraform/**/*", "terraform/modules/network/main.tf", True),
    ("terraform/**/*", "src/terraform.ts", False),
    ("**/*.test.tsx", "Button.test.tsx", True),
    ("**/*.test.tsx", "src/components/forms/TextField.test.tsx", True),
    ("**/*.test.tsx", "src/components/Button.tsx", False),
    ("**/*.test.ts", "src/components/Button.test.tsx", False),
    ("src/api/**/*", "src/api/orders.ts", True),
    ("src/api/**/*", "src/apiary/x.ts", False),
    ("src/components/**/*.tsx", "src/components/Button.tsx", True),
    ("src/components/*.tsx", "src/components/forms/TextField.tsx", False),
    ("src/**/*.{ts,tsx}", "src/lib/money.ts", True),
    ("src/**/*.{ts,tsx}", "src/components/Button.tsx", True),
    ("src/**/*.{ts,tsx}", "src/components/Button.module.css", False),
    ("e2e/*.test.?s", "e2e/checkout.test.ts", True),
    ("**/[!_]*.md", "docs/_draft.md", False),
    ("**/[!_]*.md", "docs/guide.md", True),
]
