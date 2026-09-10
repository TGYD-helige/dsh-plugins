/**
 * Shell command segmentation for policy matching.
 *
 * dsh's bash/pwsh tools receive one raw command string, so a prefix rule that
 * only examined the whole string would miss `cd /tmp && npm install`. The
 * splitter is quote-aware and pulls `$( )` / backtick substitutions out as
 * their own segments (recursively) — `echo "$(npm install)"` must still hit an
 * npm rule. Over-splitting is safe (every piece is checked on its own);
 * `commandPrefix` / `commandRegex` rules match against these segments.
 */

const isWordBoundary = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * A prefix matches a segment only at a word boundary: `npm` matches
 * `npm install` and `npm` itself, never `npmx` or `npm-cache`.
 */
export function matchesPrefix(segment: string, prefix: string): boolean {
  const trimmed = segment.trimStart();
  return trimmed.startsWith(prefix) && isWordBoundary(trimmed[prefix.length]);
}

/** Read a `$(`...`)` body starting just after the opening paren. */
function readParenSubshell(text: string, start: number): { body: string; end: number } {
  let depth = 1;
  let quote: string | undefined;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\' && quote !== "'") i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start, i), end: i + 1 };
    }
    i += 1;
  }
  return { body: text.slice(start), end: text.length }; // unbalanced: take the rest
}

/**
 * Split a compound command into the segments a shell would run: pipelines,
 * `&&`/`||`/`;`/newline chains, background `&`, plus the interiors of
 * `$( )` and backtick substitutions (which execute even inside double
 * quotes). Quoted operator characters stay literal.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = '';
  let quote: string | undefined;
  const push = () => {
    const trimmed = buf.trim();
    if (trimmed !== '') segments.push(trimmed);
    buf = '';
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    // Substitution contents execute inside double quotes but are literal in
    // single quotes — extract them from everywhere except '...'.
    if (quote !== "'") {
      if (ch === '$' && command[i + 1] === '(') {
        const { body, end } = readParenSubshell(command, i + 2);
        segments.push(...splitSegments(body));
        i = end;
        continue;
      }
      if (ch === '`') {
        const close = command.indexOf('`', i + 1);
        segments.push(
          ...splitSegments(close === -1 ? command.slice(i + 1) : command.slice(i + 1, close)),
        );
        i = close === -1 ? command.length : close + 1;
        continue;
      }
    }
    if (quote !== undefined) {
      buf += ch;
      if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      buf += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      push();
      i += command[i + 1] === ch && (ch === '|' || ch === '&') ? 2 : 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  push();
  return segments;
}
