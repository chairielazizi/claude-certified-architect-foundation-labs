/**
 * A small, dependency-free path glob matcher (the syntax `paths:` frontmatter uses).
 *
 *   **      any number of directories, including none, when it is a whole path segment
 *   *       any characters except "/"
 *   ?       exactly one character except "/"
 *   {a,b}   alternation, may nest
 *   [abc]   character class; [!abc] negates
 *
 * Paths are matched relative to the project root, with forward slashes.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "src/*.{ts,tsx}" -> ["src/*.ts", "src/*.tsx"]. Expanding first keeps `**` handling simple. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth) {
      depth--;
      if (depth === 0) {
        const options: string[] = [];
        let level = 0;
        let current = "";
        for (const c of pattern.slice(start + 1, i)) {
          if (c === "," && level === 0) {
            options.push(current);
            current = "";
            continue;
          }
          level += (c === "{" ? 1 : 0) - (c === "}" ? 1 : 0);
          current += c;
        }
        options.push(current);
        if (options.length < 2) return [pattern]; // "{a}" is not an alternation
        const head = pattern.slice(0, start);
        const tail = pattern.slice(i + 1);
        return options.flatMap((option) => expandBraces(head + option + tail));
      }
    }
  }
  return [pattern];
}

/** One brace-free glob -> regular expression source. */
function translate(pattern: string): string {
  const out: string[] = [];
  const n = pattern.length;
  for (let i = 0; i < n; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern.startsWith("**", i)) {
        const segmentStart = i === 0 || pattern[i - 1] === "/";
        const after = i + 2;
        if (segmentStart && after < n && pattern[after] === "/") {
          out.push("(?:.*/)?"); // "**/" = zero or more whole directories
          i = after;
          continue;
        }
        out.push(".*"); // trailing "/**" or "**" glued to text: anything, across "/"
        i = after - 1;
        continue;
      }
      out.push("[^/]*");
    } else if (ch === "?") {
      out.push("[^/]");
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out.push(escapeRe(ch));
      } else {
        let body = pattern.slice(i + 1, close);
        const negate = body.startsWith("!");
        if (negate) body = body.slice(1);
        out.push((negate ? "[^" : "[") + body.replace(/\\/g, "\\\\") + "]");
        i = close;
      }
    } else {
      out.push(escapeRe(ch));
    }
  }
  return out.join("");
}

const cache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(`^(?:${expandBraces(pattern).map(translate).join("|")})$`);
    cache.set(pattern, re);
  }
  return re;
}

/** True when the project-relative `file` matches the glob `pattern`. */
export function globMatch(pattern: string, file: string): boolean {
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern; // "./src/**" means "src/**"
  return compileGlob(normalized).test(file.replace(/\\/g, "/"));
}

/** [pattern, path, expected] - run by ruleLoader.ts as a self-test. */
export const SELF_TEST: Array<[string, string, boolean]> = [
  ["terraform/**/*", "terraform/main.tf", true],
  ["terraform/**/*", "terraform/modules/network/main.tf", true],
  ["terraform/**/*", "src/terraform.ts", false],
  ["**/*.test.tsx", "Button.test.tsx", true],
  ["**/*.test.tsx", "src/components/forms/TextField.test.tsx", true],
  ["**/*.test.tsx", "src/components/Button.tsx", false],
  ["**/*.test.ts", "src/components/Button.test.tsx", false],
  ["src/api/**/*", "src/api/orders.ts", true],
  ["src/api/**/*", "src/apiary/x.ts", false],
  ["src/components/**/*.tsx", "src/components/Button.tsx", true],
  ["src/components/*.tsx", "src/components/forms/TextField.tsx", false],
  ["src/**/*.{ts,tsx}", "src/lib/money.ts", true],
  ["src/**/*.{ts,tsx}", "src/components/Button.tsx", true],
  ["src/**/*.{ts,tsx}", "src/components/Button.module.css", false],
  ["e2e/*.test.?s", "e2e/checkout.test.ts", true],
  ["**/[!_]*.md", "docs/_draft.md", false],
  ["**/[!_]*.md", "docs/guide.md", true],
];
