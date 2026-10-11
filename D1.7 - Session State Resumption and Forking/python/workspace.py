"""The code the D1.7 investigation analyses, and the edits made to it between work sessions.

Each demo recreates its workspace under <lab>/.lab-runtime/<demo>/workspace on every run, so
reruns are deterministic:

    v1                 auth/login.py, session.py, tokens.py, middleware.py   (session 1 analyses this)
    apply_small_edit   tokens.py gains an exp claim         -> 1 of 4 files changed (resume)
    apply_refactor     login.py + session.py rewritten, middleware.py deleted,
                       oauth.py added                       -> 3 of 4 analysed files stale (start fresh)
"""

from __future__ import annotations

import shutil
from pathlib import Path

LAB_DIR = Path(__file__).resolve().parents[1]
RUNTIME = LAB_DIR / ".lab-runtime"

V1 = {
    "auth/login.py": '''"""Login: check a password against the stored one."""
from auth.session import new_session


def login(user, password, users):
    stored = users.get(user)
    if stored is not None and password == stored["password"]:
        return new_session(user)
    return None
''',
    "auth/session.py": '''"""Session ids."""
import random


def new_session(user):
    return {"user": user, "sid": str(random.random())}
''',
    "auth/tokens.py": '''"""API tokens (JWT)."""
import jwt

SECRET = "dev-secret"


def issue_token(user):
    return jwt.encode({"sub": user}, SECRET, algorithm="HS256")
''',
    "auth/middleware.py": '''"""Request auth middleware."""


def requires_auth(path):
    return not path.startswith("/pub")
''',
}

TOKENS_V2 = '''"""API tokens (JWT)."""
import time

import jwt

SECRET = "dev-secret"


def issue_token(user):
    return jwt.encode({"sub": user, "exp": int(time.time()) + 3600}, SECRET, algorithm="HS256")
'''

REFACTOR = {
    "auth/login.py": '''"""Login: verify a bcrypt hash."""
import bcrypt

from auth.session import new_session


def login(user, password, users):
    stored = users.get(user)
    if stored is not None and bcrypt.checkpw(password.encode(), stored["hash"]):
        return new_session(user)
    return None
''',
    "auth/session.py": '''"""Session ids."""
import secrets


def new_session(user):
    return {"user": user, "sid": secrets.token_urlsafe(32)}
''',
    "auth/oauth.py": '''"""OAuth callback handling (replaces middleware.py)."""
import requests


def exchange_code(code):
    return requests.post("https://idp.example.com/token", data={"code": code}, verify=False).json()
''',
}
REFACTOR_DELETES = ["auth/middleware.py"]


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n" keeps bytes (and therefore hashes) identical to the TypeScript twin on Windows.
    path.write_text(text, encoding="utf-8", newline="\n")


def reset_workspace(root: Path) -> Path:
    shutil.rmtree(root, ignore_errors=True)
    for rel, text in V1.items():
        _write(root, rel, text)
    return root


def apply_small_edit(root: Path) -> None:
    _write(root, "auth/tokens.py", TOKENS_V2)


def apply_refactor(root: Path) -> None:
    for rel, text in REFACTOR.items():
        _write(root, rel, text)
    for rel in REFACTOR_DELETES:
        (root / rel).unlink(missing_ok=True)


def list_files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*.py"))
