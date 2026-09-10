import { describe, expect, it } from 'vitest';
import { matchesPrefix, splitSegments } from './shell.js';

describe('splitSegments', () => {
  it('splits pipes, chains, semicolons and newlines', () => {
    expect(splitSegments('cd /tmp && npm install | grep err; echo done')).toEqual([
      'cd /tmp',
      'npm install',
      'grep err',
      'echo done',
    ]);
    expect(splitSegments('npm i || true')).toEqual(['npm i', 'true']);
    expect(splitSegments('npm i\nnpm test')).toEqual(['npm i', 'npm test']);
  });

  it('splits background & so a backgrounded command is still checked', () => {
    expect(splitSegments('npm i &')).toEqual(['npm i']);
    expect(splitSegments('sleep 1 & npm i')).toEqual(['sleep 1', 'npm i']);
  });

  it('keeps operators inside quotes literal', () => {
    expect(splitSegments('echo "a && b" && npm i')).toEqual(['echo "a && b"', 'npm i']);
    expect(splitSegments("echo 'a | b'")).toEqual(["echo 'a | b'"]);
  });

  it('respects backslash escapes', () => {
    expect(splitSegments('echo a\\;b && npm i')).toEqual(['echo a\\;b', 'npm i']);
    expect(splitSegments('echo "\\$(npm i)"')).toEqual(['echo "\\$(npm i)"']);
  });

  it('extracts $( ) interiors as their own segments, recursively', () => {
    // Substitution interiors land at the extraction point; the surrounding
    // command segment is pushed when its own end is reached.
    expect(splitSegments('echo $(npm install) done')).toEqual(['npm install', 'echo  done']);
    expect(splitSegments('echo $(npm i && npm test)')).toEqual(['npm i', 'npm test', 'echo']);
  });

  it('extracts substitutions inside double quotes but not single quotes', () => {
    expect(splitSegments('echo "$(npm install)"')).toEqual(['npm install', 'echo ""']);
    expect(splitSegments("echo '$(npm install)'")).toEqual(["echo '$(npm install)'"]);
  });

  it('extracts backtick interiors', () => {
    expect(splitSegments('echo `npm i`')).toEqual(['npm i', 'echo']);
  });

  it('trims and drops empty segments', () => {
    expect(splitSegments('  npm i  ;  ; npm test  ')).toEqual(['npm i', 'npm test']);
    expect(splitSegments('   ')).toEqual([]);
  });
});

describe('matchesPrefix', () => {
  it('matches at the segment start', () => {
    expect(matchesPrefix('npm install', 'npm')).toBe(true);
    expect(matchesPrefix('bun run lint', 'bun run')).toBe(true);
  });

  it('ignores leading whitespace', () => {
    expect(matchesPrefix('  npm i', 'npm')).toBe(true);
  });

  it('requires a word boundary after the prefix', () => {
    expect(matchesPrefix('npmx install', 'npm')).toBe(false);
    expect(matchesPrefix('npm-cache verify', 'npm')).toBe(false);
  });

  it('matches the bare command itself', () => {
    expect(matchesPrefix('npm', 'npm')).toBe(true);
  });
});
