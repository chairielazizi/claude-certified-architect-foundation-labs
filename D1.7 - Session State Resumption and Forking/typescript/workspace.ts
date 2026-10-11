/**
 * The code the D1.7 investigation analyses, and the edits made to it between work sessions.
 *
 * Each demo recreates its workspace under <lab>/.lab-runtime/<demo>/workspace on every run, so
 * reruns are deterministic:
 *   v1               auth/login.py, session.py, tokens.py, middleware.py   (session 1 analyses this)
 *   applySmallEdit   tokens.py gains an exp claim         -> 1 of 4 files changed (resume)
 *   applyRefactor    login.py + session.py rewritten, middleware.py deleted,
 *                    oauth.py added                       -> 3 of 4 analysed files stale (start fresh)
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME = path.join(LAB_DIR, ".lab-runtime");

// File contents are byte-identical to the Python twin (so the hashes match too).
const V1: Record<string, string> = {
  "auth/login.py": `"""Login: check a password against the stored one."""
from auth.session import new_session


def login(user, password, users):
    stored = users.get(user)
    if stored is not None and password == stored["password"]:
        return new_session(user)
    return None
`,
  "auth/session.py": `"""Session ids."""
import random


def new_session(user):
    return {"user": user, "sid": str(random.random())}
`,
  "auth/tokens.py": `"""API tokens (JWT)."""
import jwt

SECRET = "dev-secret"


def issue_token(user):
    return jwt.encode({"sub": user}, SECRET, algorithm="HS256")
`,
  "auth/middleware.py": `"""Request auth middleware."""


def requires_auth(path):
    return not path.startswith("/pub")
`,
};

const TOKENS_V2 = `"""API tokens (JWT)."""
import time

import jwt

SECRET = "dev-secret"


def issue_token(user):
    return jwt.encode({"sub": user, "exp": int(time.time()) + 3600}, SECRET, algorithm="HS256")
`;

const REFACTOR: Record<string, string> = {
  "auth/login.py": `"""Login: verify a bcrypt hash."""
import bcrypt

from auth.session import new_session


def login(user, password, users):
    stored = users.get(user)
    if stored is not None and bcrypt.checkpw(password.encode(), stored["hash"]):
        return new_session(user)
    return None
`,
  "auth/session.py": `"""Session ids."""
import secrets


def new_session(user):
    return {"user": user, "sid": secrets.token_urlsafe(32)}
`,
  "auth/oauth.py": `"""OAuth callback handling (replaces middleware.py)."""
import requests


def exchange_code(code):
    return requests.post("https://idp.example.com/token", data={"code": code}, verify=False).json()
`,
};
const REFACTOR_DELETES = ["auth/middleware.py"];

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

export function resetWorkspace(root: string): string {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(V1)) write(root, rel, text);
  return root;
}

export function applySmallEdit(root: string): void {
  write(root, "auth/tokens.py", TOKENS_V2);
}

export function applyRefactor(root: string): void {
  for (const [rel, text] of Object.entries(REFACTOR)) write(root, rel, text);
  for (const rel of REFACTOR_DELETES) rmSync(path.join(root, rel), { force: true });
}

/** Relative POSIX paths of every .py file under root, sorted. */
export function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.name.endsWith(".py")) out.push(rel);
  }
  return out.sort();
}
