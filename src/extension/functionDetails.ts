/**
 * Reads the signature and documentation of a function from its source text,
 * for the hover card of the graph. Line-based rules per language family, so
 * nothing has to be parsed again. Pure, so it is unit-tested.
 */
import type { FunctionDetails } from '../shared';
import { MAX_DETAILS_TEXT } from '../shared';

/** Language families with different comment and declaration rules. */
type Family = 'c' | 'python';

/** Most lines read for a signature (long parameter lists). */
const MAX_SIGNATURE_LINES = 8;

/** Most lines read for a doc comment. */
const MAX_DOC_LINES = 40;

/** Longest signature shown. */
const MAX_SIGNATURE_LENGTH = 240;

/** Longest doc text shown. */
const MAX_DOC_LENGTH = 600;

/**
 * Picks the language family of a file.
 *
 * @param filePath - Workspace path.
 * @returns `python` for `.py`, otherwise `c` (TS/JS, Java, C#, Go).
 */
function familyOf(filePath: string): Family {
  return filePath.endsWith('.py') ? 'python' : 'c';
}

/**
 * Shortens a text to a maximum length with an ellipsis.
 *
 * @param text - Text.
 * @param max - Maximum length.
 * @returns The text, shortened if needed.
 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Collapses runs of whitespace into single spaces.
 *
 * @param text - Text.
 * @returns The normalized text.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Tells whether a line is an annotation, decorator or attribute that sits
 * between a doc comment and its declaration (`@Override`, `[HttpGet]`).
 *
 * @param line - Trimmed line.
 * @returns `true` for such lines.
 */
function isAnnotation(line: string): boolean {
  return line.startsWith('@') || /^\[[A-Za-z][^\]]*\]$/.test(line);
}

/** Characters after which `{` starts a type, not a function body. */
const TYPE_CONTEXT = [':', '|', '&', '<', ',', '('];

/**
 * Tells whether a declaration without a body ends on this line: an abstract
 * or interface method (`save(user: User): void;`, Go `Save(u User) error`).
 *
 * @param parts - Declaration lines read so far.
 * @param line - Current line.
 * @returns `true` when the declaration is complete.
 */
function isCompleteDeclaration(parts: readonly string[], line: string): boolean {
  const trimmed = line.trimEnd();
  if (trimmed.endsWith(';')) {
    return true;
  }
  const hasParameters = parts.some((part) => part.includes('('));
  return hasParameters && trimmed !== '' && !/[,(=:|&<]$/.test(trimmed);
}

/**
 * Reads the declaration of a function: from its first line until the body
 * starts (`{`, `=>` or `:` in Python) once the parentheses are closed.
 *
 * @param lines - Lines of the file.
 * @param start - 0-based line of the declaration.
 * @param family - Language family.
 * @returns The signature and the 0-based line where it ends.
 */
function readSignature(
  lines: readonly string[],
  start: number,
  family: Family,
): { readonly signature: string; readonly end: number } {
  let first = start;
  // Decorators and annotations may be reported as the start of the function.
  while (first < lines.length - 1 && isAnnotation((lines[first] ?? '').trim())) {
    first += 1;
  }
  const parts: string[] = [];
  let depth = 0;
  let end = first;
  // Last character that is not a space, across lines (tells a type literal `: {` from a body `{`).
  let previous = '';
  for (let index = first; index < Math.min(lines.length, first + MAX_SIGNATURE_LINES); index += 1) {
    const line = lines[index] ?? '';
    end = index;
    let cut = -1;
    for (let position = 0; position < line.length; position += 1) {
      const char = line[position] ?? '';
      if (char === '(' || char === '[') {
        depth += 1;
      } else if (char === ')' || char === ']') {
        depth -= 1;
      } else if (char === '{' && (depth > 0 || TYPE_CONTEXT.includes(previous))) {
        // Object parameter or type literal (`): { id: string }`), not the body.
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
      } else if (depth <= 0) {
        if (family === 'c' && char === '{') {
          cut = position;
          break;
        }
        if (family === 'c' && char === '=' && line[position + 1] === '>') {
          cut = position + 2;
          break;
        }
        if (family === 'python' && char === ':' && line.slice(position + 1).trim() === '') {
          cut = position;
          break;
        }
      }
      if (char.trim() !== '') {
        previous = char;
      }
    }
    parts.push(cut === -1 ? line : line.slice(0, cut));
    if (cut !== -1 || (family === 'c' && depth <= 0 && isCompleteDeclaration(parts, line))) {
      break;
    }
  }
  const signature = squash(parts.join(' '))
    .replace(/;$/, '')
    .replace(/\s*=>$/, '')
    .replace(/([([])\s+/g, '$1')
    .replace(/,?\s+([)\]])/g, '$1')
    .trim();
  return { signature: clip(signature, MAX_SIGNATURE_LENGTH), end };
}

/**
 * Keeps the first paragraph of a doc text, without tags (`@param`,
 * `<summary>`).
 *
 * @param lines - Doc lines without comment markers.
 * @returns The text, or `null` when empty.
 */
function firstParagraph(lines: readonly string[]): string | null {
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/<\/?(summary|remarks|para|p)>/gi, '').trim();
    if (line.startsWith('@') || line.startsWith(':param') || line.startsWith('Args:')) {
      break;
    }
    if (line === '') {
      if (kept.length > 0) {
        break;
      }
      continue;
    }
    kept.push(line.replace(/<see cref="([^"]+)"\s*\/>/g, '$1').replace(/<[^>]+>/g, ''));
  }
  const text = squash(kept.join(' '));
  return text === '' ? null : clip(text, MAX_DOC_LENGTH);
}

/**
 * Reads the comment right above a declaration: a block comment (`/** … *\/`)
 * or consecutive line comments (`//`, `///`, `#`).
 *
 * @param lines - Lines of the file.
 * @param start - 0-based line of the declaration.
 * @param family - Language family.
 * @returns The doc text, or `null`.
 */
function readCommentAbove(lines: readonly string[], start: number, family: Family): string | null {
  let index = start - 1;
  while (index >= 0 && isAnnotation((lines[index] ?? '').trim())) {
    index -= 1;
  }
  const last = (lines[index] ?? '').trim();
  if (family === 'c' && last.endsWith('*/')) {
    const block: string[] = [];
    for (let line = index; line >= 0 && index - line < MAX_DOC_LINES; line -= 1) {
      const text = (lines[line] ?? '').trim();
      block.unshift(text);
      if (text.startsWith('/*')) {
        return firstParagraph(
          block.map((item) =>
            item
              .replace(/^\/\*\*?/, '')
              .replace(/\*\/$/, '')
              .replace(/^\*\s?/, ''),
          ),
        );
      }
    }
    return null;
  }
  const marker = family === 'python' ? /^#\s?/ : /^\/\/\/?\s?/;
  const block: string[] = [];
  for (let line = index; line >= 0 && index - line < MAX_DOC_LINES; line -= 1) {
    const text = (lines[line] ?? '').trim();
    if (!marker.test(text)) {
      break;
    }
    block.unshift(text.replace(marker, ''));
  }
  return block.length === 0 ? null : firstParagraph(block);
}

/**
 * Reads a Python docstring: the string right after the `def` line.
 *
 * @param lines - Lines of the file.
 * @param after - 0-based line where the signature ends.
 * @returns The doc text, or `null`.
 */
function readDocstring(lines: readonly string[], after: number): string | null {
  let index = after + 1;
  while (index < lines.length && (lines[index] ?? '').trim() === '') {
    index += 1;
  }
  const opening = /^[rRuUbB]?("""|''')/.exec((lines[index] ?? '').trim());
  if (opening === null) {
    return null;
  }
  const quote = opening[1] ?? '"""';
  const body: string[] = [];
  for (let line = index; line < lines.length && line - index < MAX_DOC_LINES; line += 1) {
    let text = (lines[line] ?? '').trim();
    if (line === index) {
      text = text.slice(opening[0].length);
    }
    const close = text.indexOf(quote);
    if (close !== -1) {
      body.push(text.slice(0, close));
      return firstParagraph(body);
    }
    body.push(text);
  }
  return firstParagraph(body);
}

/**
 * Reads the signature and documentation of a function.
 *
 * @param text - Source of the file.
 * @param filePath - Workspace path of the file (its extension picks the rules).
 * @param line - 1-based line where the function starts.
 * @returns The details, or `null` when the line is outside the file.
 */
export function extractFunctionDetails(
  text: string,
  filePath: string,
  line: number,
): FunctionDetails | null {
  const lines = text.split(/\r?\n/);
  const start = line - 1;
  if (start < 0 || start >= lines.length) {
    return null;
  }
  const family = familyOf(filePath);
  const { signature, end } = readSignature(lines, start, family);
  const doc =
    (family === 'python' ? readDocstring(lines, end) : null) ??
    readCommentAbove(lines, start, family);
  return {
    signature: clip(signature, MAX_DETAILS_TEXT),
    doc: doc === null ? null : clip(doc, MAX_DETAILS_TEXT),
  };
}
