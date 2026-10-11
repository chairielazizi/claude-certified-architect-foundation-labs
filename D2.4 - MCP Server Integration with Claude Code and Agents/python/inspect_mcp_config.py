"""D2.4 - Inspect a project .mcp.json: secrets lint, ${VAR} expansion, tool union.

  1. lint:      credentials must come from ${VAR} references, never literals. Runs on the
                committed example-project/.mcp.json (clean) and on a leaky variant (flagged).
  2. expand:    the ${VAR} / ${VAR:-default} expansion Claude Code applies to command, args,
                env, url and headers, run against a FAKE environment. Unset without a default
                -> warning, and the text stays literal.
  3. discover:  tools from ALL configured servers are available at the same time, named
                mcp__<server>__<tool>. team-kb's list comes from the real server object;
                the github / issue-tracker lists are ILLUSTRATIVE (the real ones arrive
                from those servers at connection time).

Always offline. Run:  python inspect_mcp_config.py
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "example-project" / "servers"))
import labkit as lab  # noqa: E402
from team_kb_server import build_server  # noqa: E402

PROJECT = Path(__file__).resolve().parents[1] / "example-project"

VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
SENSITIVE_KEY = re.compile(r"token|secret|passw|api[_-]?key|authorization|auth", re.I)
TOKEN_SHAPE = re.compile(r"(ghp_|github_pat_|xox[abpr]-|sk-|AKIA)[A-Za-z0-9_\-]{8,}")

SERVER_KIND = {
    "github": "existing vendor server (remote http) - standard integration, not built here",
    "issue-tracker": "EXAMPLE community/vendor issue-tracker server - standard integration, not built here",
    "team-kb": "custom server (servers/team_kb_server.py) - team-specific KB, owners, schema",
}
ILLUSTRATIVE_REMOTE_TOOLS = {  # names for illustration only; real lists come from the servers
    "github": ["search_code", "get_pull_request", "create_issue", "list_commits"],
    "issue-tracker": ["search_issues", "get_issue", "add_comment"],
}

# A config someone might be tempted to commit. The token is assembled at runtime so that
# no token-shaped literal sits in this repository.
FAKE_PAT = "ghp_" + "0" * 36
LEAKY_CONFIG = {
    "mcpServers": {
        "github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": f"Bearer {FAKE_PAT}"}},
        "team-kb": {"type": "stdio", "command": "python", "args": ["servers/team_kb_server.py", "--serve"],
                    "env": {"KB_TOKEN": "kb-prod-7f3a9c1e", "KB_URL": "http://localhost:8080"}},
    }
}

FAKE_ENV = {"GITHUB_TOKEN": "gh-test-token-123", "KB_TOKEN": "kb-test-token-456"}  # JIRA_*, KB_URL unset


def lint_secrets(config: dict[str, Any]) -> list[str]:
    findings = []
    for name, server in config["mcpServers"].items():
        for section in ("headers", "env"):
            for key, value in server.get(section, {}).items():
                if SENSITIVE_KEY.search(key) and not VAR.search(value):
                    var = key if section == "env" else name.upper().replace("-", "_") + "_TOKEN"
                    findings.append(f"{name}.{section}.{key}: literal credential; reference ${{{var}}} instead")
        strings = [server.get("url", ""), server.get("command", ""), *server.get("args", []),
                   *server.get("headers", {}).values(), *server.get("env", {}).values()]
        for value in strings:
            if TOKEN_SHAPE.search(value):
                findings.append(f"{name}: token-shaped literal {value[:12]}... will be committed with the file")
    return findings


def expand(value: str, env: dict[str, str], warnings: list[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        if name in env:
            return env[name]
        if default is not None:
            return default
        warnings.append(f"${{{name}}} is not set and has no default; the literal text is kept")
        return match.group(0)

    return VAR.sub(replace, value)


def expand_server(server: dict[str, Any], env: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    """Apply expansion where Claude Code does: command, args, env, url, headers."""
    warnings: list[str] = []
    out = copy.deepcopy(server)
    for field in ("command", "url"):
        if field in out:
            out[field] = expand(out[field], env, warnings)
    if "args" in out:
        out["args"] = [expand(a, env, warnings) for a in out["args"]]
    for section in ("env", "headers"):
        if section in out:
            out[section] = {k: expand(v, env, warnings) for k, v in out[section].items()}
    return out, warnings


def masked(server: dict[str, Any]) -> dict[str, Any]:
    """Hide credential values when printing."""
    out = copy.deepcopy(server)
    for section in ("env", "headers"):
        for key, value in out.get(section, {}).items():
            if SENSITIVE_KEY.search(key) and not VAR.search(value):
                out[section][key] = value[:10] + "****"
    return out


async def main() -> None:
    lab.banner("D2.4  Inspect .mcp.json: secrets, ${VAR} expansion, tools from every server")
    config = json.loads((PROJECT / ".mcp.json").read_text(encoding="utf-8"))

    lab.section("1. Secrets lint")
    committed = lint_secrets(config)
    leaky = lint_secrets(LEAKY_CONFIG)
    print(f"  example-project/.mcp.json: {len(committed)} finding(s)")
    print("  leaky variant:")
    for finding in leaky:
        print(f"      - {finding}")

    lab.section("2. Expansion against a fake environment")
    print(f"  fake env: { {k: v[:7] + '...' for k, v in FAKE_ENV.items()} }  (JIRA_MCP_URL, JIRA_API_TOKEN, KB_URL unset)")
    expanded: dict[str, dict[str, Any]] = {}
    all_warnings: list[str] = []
    for name, server in config["mcpServers"].items():
        result, warnings = expand_server(server, FAKE_ENV)
        expanded[name] = result
        all_warnings += warnings
        print(f"  {name}: {json.dumps(masked(result))}")
        for warning in warnings:
            print(f"      WARNING {warning}")

    lab.section("3. Servers and the tools the agent sees (all at once)")
    kb_tools = [t.name for t in await build_server().list_tools()]
    union: list[str] = []
    for name, server in config["mcpServers"].items():
        tools = kb_tools if name == "team-kb" else ILLUSTRATIVE_REMOTE_TOOLS[name]
        source = "from the real server object" if name == "team-kb" else "illustrative"
        print(f"  {name:<14} {server.get('type', 'stdio'):<6} {SERVER_KIND[name]}")
        print(f"      tools ({source}): {', '.join(tools)}")
        union += [f"mcp__{name}__{tool}" for tool in tools]
    print(f"  union seen by the agent ({len(union)} tools): {union}")

    lab.section("Checks")
    lab.check(not committed, "committed .mcp.json has no literal secrets (all credentials are ${VAR} references)")
    lab.check(len(leaky) >= 3, "leaky variant flagged: literal Authorization header, token-shaped value, literal KB_TOKEN")
    lab.check(expanded["github"]["headers"]["Authorization"] == "Bearer gh-test-token-123", "${GITHUB_TOKEN} expanded from the environment")
    lab.check(expanded["team-kb"]["env"]["KB_URL"] == "http://localhost:8080", "${KB_URL:-http://localhost:8080} fell back to its default")
    lab.check(expanded["issue-tracker"]["url"] == "${JIRA_MCP_URL}" and any("JIRA_MCP_URL" in w for w in all_warnings),
              "unset ${JIRA_MCP_URL} without default -> warning, value left literal")
    lab.check(len(union) == len(set(union)) == 11 and all(t.startswith("mcp__") for t in union),
              "tools from all three servers are available together, namespaced mcp__<server>__<tool>")


if __name__ == "__main__":
    lab.run(main())
