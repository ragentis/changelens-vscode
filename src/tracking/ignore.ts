interface Rule {
  regex: RegExp;
  negated: boolean;
}

/**
 * VS Code folds glob case on macOS, but ChangeLens deliberately does not. A case-sensitive macOS
 * volume can contain paths that differ only by case, and folding an exclude could hide a real
 * change. Windows folds case; matching stays case-sensitive elsewhere.
 */
const CASE_FLAGS = process.platform === "win32" ? "i" : "";

// ── glob to regex ────────────────────────────────────────────────────────────

function escapeRegex(text: string): string {
  return text.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
}

/**
 * Escapes a glob character class for JavaScript regex syntax. A leading `]` is a glob member, as
 * in `[]]`, but would close an empty regex class; `-` stays unescaped because both use it for ranges.
 */
function classBody(raw: string): string {
  let body = "";
  let i = 0;
  while (i < raw.length) {
    const character = raw.charAt(i);
    if (character === "\\" && i + 1 < raw.length) {
      const escaped = raw.charAt(i + 1);
      body += /[\]\\^-]/.test(escaped) ? `\\${escaped}` : escaped;
      i += 2;
      continue;
    }
    body += /[\]\\^]/.test(character) ? `\\${character}` : character;
    i += 1;
  }
  return body;
}

/** Compiles a `[...]` class, leaving an unclosed `[` literal. */
function characterClass(glob: string, open: number): { body: string; end: number } | null {
  let i = open + 1;
  const negated = glob.charAt(i) === "!" || glob.charAt(i) === "^";
  if (negated) {
    i += 1;
  }

  const start = i;
  // A leading `]` belongs to the set, as in a POSIX bracket expression.
  if (glob.charAt(i) === "]") {
    i += 1;
  }
  while (i < glob.length && glob.charAt(i) !== "]") {
    i += glob.charAt(i) === "\\" ? 2 : 1;
  }
  if (i >= glob.length) {
    return null;
  }

  const set = classBody(glob.slice(start, i));
  // Even a negated class cannot match a path separator.
  return { body: negated ? `[^${set}/]` : `[${set}]`, end: i + 1 };
}

/** Expands `{a,b}` into an alternation. Returns null when the group never closes. */
function braceGroup(glob: string, open: number): { body: string; end: number } | null {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  let i = start;
  while (i < glob.length) {
    const character = glob.charAt(i);
    if (character === "\\") {
      i += 2;
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      if (depth === 0) {
        parts.push(glob.slice(start, i));
        const alternatives = parts.map((part) => globToRegexBody(part, true));
        return { body: `(?:${alternatives.join("|")})`, end: i + 1 };
      }
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(glob.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  return null;
}

/** Enables `{a,b}` alternation for VS Code excludes but not gitignore patterns. */
function globToRegexBody(glob: string, braces: boolean): string {
  let body = "";
  let i = 0;
  while (i < glob.length) {
    const character = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      body += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      body += "(?:/.*)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      body += ".*";
      i += 2;
    } else if (character === "*") {
      body += "[^/]*";
      i += 1;
    } else if (character === "?") {
      body += "[^/]";
      i += 1;
    } else if (character === "\\" && i + 1 < glob.length) {
      body += escapeRegex(glob.charAt(i + 1));
      i += 2;
    } else if (character === "[") {
      const set = characterClass(glob, i);
      body += set ? set.body : escapeRegex(character);
      i = set ? set.end : i + 1;
    } else if (braces && character === "{") {
      const group = braceGroup(glob, i);
      body += group ? group.body : escapeRegex(character);
      i = group ? group.end : i + 1;
    } else {
      body += escapeRegex(character);
      i += 1;
    }
  }
  return body;
}

function compile(pattern: string, braces: boolean): Rule | null {
  let raw = pattern.trim();
  if (!raw || raw.startsWith("#")) {
    return null;
  }
  const negated = raw.startsWith("!");
  if (negated) {
    raw = raw.slice(1);
  }
  const directoryOnly = raw.endsWith("/");
  if (directoryOnly) {
    raw = raw.slice(0, -1);
  }
  const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
  if (raw.startsWith("/")) {
    raw = raw.slice(1);
  }
  if (!raw) {
    return null;
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // `ignores` receives files, so a directory-only rule matches descendants, not a same-name file.
  const suffix = directoryOnly ? "/.*$" : "(?:/.*)?$";
  return {
    regex: new RegExp(`${prefix}${globToRegexBody(raw, braces)}${suffix}`, CASE_FLAGS),
    negated,
  };
}

// ── matching ─────────────────────────────────────────────────────────────────

/** Ordered ignore rules from both dialects; the last one to match a path decides. */
export class IgnoreMatcher {
  private rules: Rule[] = [];

  /** Adds VS Code-style exclude globs, including brace alternation. */
  add(patterns: Iterable<string>): void {
    this.push(patterns, true);
  }

  /** Adds supported `.gitignore` rules, which do not include brace alternation. */
  addGitignore(content: string): void {
    this.push(content.split(/\r?\n/), false);
  }

  private push(patterns: Iterable<string>, braces: boolean): void {
    for (const pattern of patterns) {
      const rule = compile(pattern, braces);
      if (rule) {
        this.rules.push(rule);
      }
    }
  }

  /** `relativePath` must be workspace-relative and use forward slashes. */
  ignores(relativePath: string): boolean {
    // Git never descends into an excluded directory, so no later rule can re-include something
    // beneath one. The trailing slash asks each rule about the directory rather than a file of
    // the same name, which is what distinguishes `!build/keep.txt` from `!build/`.
    const segments = relativePath.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      if (this.matches(`${segments.slice(0, depth).join("/")}/`)) {
        return true;
      }
    }
    return this.matches(relativePath);
  }

  /** The plain last-match-wins pass over one candidate path. */
  private matches(candidate: string): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(candidate)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
