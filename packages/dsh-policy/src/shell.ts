/**
 * Shell command segmentation for policy matching.
 *
 * dsh's bash/pwsh tools receive one raw command string, so a prefix rule that
 * only examined the whole string would miss `cd /tmp && npm install`. The
 * splitter is quote-aware, normalizes the executable command word, and pulls
 * command/process substitutions out as their own segments (recursively).
 * Here-doc bodies stay data except for real substitutions in unquoted bodies;
 * `commandPrefix` / `commandRegex` rules match against the resulting segments.
 */

const isWordBoundary = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

export type ShellDialect = 'bash' | 'pwsh';

/** Remove shell quoting and escapes from the first word, leaving its arguments untouched. */
export function normalizeCommandWord(segment: string, dialect: ShellDialect = 'bash'): string {
  let i = 0;
  while (/\s/.test(segment[i] ?? '')) i += 1;
  const start = i;
  let word = '';
  let quote: string | undefined;
  while (i < segment.length) {
    const ch = segment[i];
    if (quote === undefined && /\s/.test(ch)) break;
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        i += 1;
      } else if (dialect === 'pwsh' && ch === '`' && quote !== "'" && i + 1 < segment.length) {
        word += segment[i + 1];
        i += 2;
      } else if (dialect === 'bash' && ch === '\\' && quote !== "'" && i + 1 < segment.length) {
        const next = segment[i + 1];
        if (next === '\n') i += 2;
        else {
          if ('$`"\\'.includes(next)) word += next;
          else word += ch + next;
          i += 2;
        }
      } else {
        word += ch;
        i += 1;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
    } else if (dialect === 'pwsh' && ch === '`' && i + 1 < segment.length) {
      word += segment[i + 1];
      i += 2;
    } else if (dialect === 'bash' && ch === '\\' && i + 1 < segment.length) {
      if (segment[i + 1] !== '\n') word += segment[i + 1];
      i += 2;
    } else {
      word += ch;
      i += 1;
    }
  }
  return segment.slice(0, start) + word + segment.slice(i);
}

/**
 * A prefix matches a segment only at a word boundary: `npm` matches
 * `npm install` and `npm` itself, never `npmx` or `npm-cache`.
 */
export function matchesPrefix(
  segment: string,
  prefix: string,
  dialect: ShellDialect = 'bash',
): boolean {
  const trimmed = normalizeCommandWord(segment, dialect).trimStart();
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

/** Read a simple here-doc, including a shell-chain tail on its declaration line. */
function readHereDoc(text: string, start: number) {
  // Bash here-strings (<<<) are ordinary input, not here-doc declarations.
  // Check both sides because the splitter also offers the second '<' as a start.
  if (text[start + 2] === '<' || (start > 0 && text[start - 1] === '<')) return;
  const match = /^<<(-)?[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s]+))/.exec(text.slice(start));
  if (!match) return;
  const rawDelimiter = match[0].replace(/^<<-?[ \t]*/, '');
  const delimiter = normalizeCommandWord(rawDelimiter);
  // Any quote/escape in the delimiter suppresses body expansion, including mixed forms.
  const quoted = delimiter !== rawDelimiter;
  let cursor = start + match[0].length;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  const tailStart = cursor;
  const declarationEnd = text.indexOf('\n', cursor);
  if (declarationEnd === -1) return;
  const rawTail = text.slice(tailStart, declarationEnd).replace(/\r$/, '');
  const outputRedirect = /^\s*>>?\s+\S+\s*$/.test(rawTail);
  // Keep unsupported declaration tails conservative instead of guessing shell grammar.
  if (rawTail.trim() && !outputRedirect && !/^(?:&&|\|\||[;|&])/.test(rawTail.trimStart())) return;
  const declaration = text
    .slice(start, outputRedirect ? declarationEnd : tailStart)
    .replace(/\r$/, '');
  const tail = outputRedirect ? '' : rawTail;
  const bodyStart = declarationEnd + 1;
  let lineStart = bodyStart;
  for (;;) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const candidate = match[1] ? line.replace(/^\t+/, '') : line;
    if (candidate === delimiter) {
      return {
        declaration,
        tail,
        body: text.slice(bodyStart, lineStart),
        quoted,
        end: newline === -1 ? text.length : lineEnd + 1,
      };
    }
    if (newline === -1) {
      return { declaration, tail, body: text.slice(bodyStart), quoted, end: text.length };
    }
    lineStart = lineEnd + 1;
  }
}

/** Here-doc lines are data; only command substitutions in an unquoted body execute. */
function hereDocCommands(body: string): string[] {
  const commands: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (body[i] === '$' && body[i + 1] === '(') {
      const { body: inner, end } = readParenSubshell(body, i + 2);
      commands.push(...splitSegments(inner));
      i = end;
      continue;
    }
    if (body[i] === '`') {
      let close = i + 1;
      while (close < body.length && body[close] !== '`') {
        close += body[close] === '\\' ? 2 : 1;
      }
      commands.push(...splitSegments(body.slice(i + 1, close)));
      i = close < body.length ? close + 1 : body.length;
      continue;
    }
    i += 1;
  }
  return commands;
}

/**
 * Split a compound command into the segments a shell would run: pipelines,
 * `&&`/`||`/`;`/newline chains, background `&`, plus the interiors of
 * `$( )` and backtick substitutions (which execute even inside double
 * quotes). Quoted operator characters stay literal.
 */
export function splitSegments(command: string, dialect: ShellDialect = 'bash'): string[] {
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
    if (dialect === 'pwsh' && ch === '`' && quote !== "'" && i + 1 < command.length) {
      buf += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (dialect === 'bash' && quote === undefined && ch === '<' && command[i + 1] === '<') {
      const doc = readHereDoc(command, i);
      if (doc) {
        buf += doc.declaration;
        push();
        if (!doc.quoted) segments.push(...hereDocCommands(doc.body));
        segments.push(...splitSegments(doc.tail, dialect));
        i = doc.end;
        continue;
      }
    }
    // Process substitution is unquoted Bash syntax; its interior executes too.
    if (
      dialect === 'bash' &&
      quote === undefined &&
      (ch === '<' || ch === '>') &&
      command[i + 1] === '('
    ) {
      const { body, end } = readParenSubshell(command, i + 2);
      segments.push(...splitSegments(body, dialect));
      i = end;
      continue;
    }
    // Substitution contents execute inside double quotes but are literal in
    // single quotes — extract them from everywhere except '...'.
    if (quote !== "'") {
      if (ch === '$' && command[i + 1] === '(') {
        const { body, end } = readParenSubshell(command, i + 2);
        segments.push(...splitSegments(body, dialect));
        i = end;
        continue;
      }
      if (dialect === 'bash' && ch === '`') {
        const close = command.indexOf('`', i + 1);
        segments.push(
          ...splitSegments(
            close === -1 ? command.slice(i + 1) : command.slice(i + 1, close),
            dialect,
          ),
        );
        i = close === -1 ? command.length : close + 1;
        continue;
      }
    }
    if (quote !== undefined) {
      buf += ch;
      if (dialect === 'bash' && ch === '\\' && quote !== "'" && i + 1 < command.length) {
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
    if (dialect === 'bash' && ch === '\\' && i + 1 < command.length) {
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
