// One-shot migrate-go support: a minimal YAML-subset reader + line-surgical
// editor for profile patch files (`<profileDir>/cordis.patch.yml`), plus the
// file-backed SettingsService adapter that lets the EXISTING migration engine
// (buildMigrationPlanFromDeps / applyMigration) drive a non-current profile.
//
// Why hand-rolled: this plugin keeps zero runtime dependencies (the whole
// @aiwayds plugin family convention), so there is no `yaml` import here. The
// parser accepts exactly the subset dsh profile patches use — block maps,
// block sequences, plain/quoted scalars, full-line comments, single-line flow
// collections, `!!js` expression lines — and REFUSES anything outside it
// (tabs, CRLF, unterminated constructs) with an actionable reason so a caller
// can fail closed and point at the manual migrate plan/apply path.
//
// Parse-time refusals (the "cannot silently write a file the host cannot
// load" rule, review Blocker A): every mapping key must be a BARE plain key —
// quoted keys, whitespace inside a key, and YAML indicator characters
// (#*&{[) in a key are refused; duplicate keys in the SAME mapping are
// refused (the host yaml rejects them, last-wins folding is not a valid
// edit basis); keys that the host yaml resolves to null/boolean/number
// (`~`, `true`, `1`, …) are refused because same-level spellings collapse
// into one key (`true` = `True`, `null` = `~`, `1` = `+1`) and the host
// rejects the document as duplicate-keyed (review M3); YAML anchors
// (`&name`), aliases (`*name`) and merge keys (`<<`) are refused anywhere in
// a value position. A colon-space (or trailing colon) in a plain VALUE
// position is refused: the parser used to accept `key: a: b` while the host
// yaml rejects the whole document (review M2). Tags (`!!`/`!`) keep the
// opaque-leaf behavior at block position: verbatim outside the edited
// providers tree, a refusal for any op whose target tree contains one — but
// INSIDE a flow collection a tag is refused outright, because flow values
// are decoded into the subset tree and a tagged leaf would silently become
// text (review M1). Flow scalars decode through the SAME unquoteYaml path as
// block-position quoted scalars, and flow entries that the host would parse
// differently (single-pair items like `[a: b]`, empty entries, comments
// inside the brackets) are refused, never guessed. All of these fail at
// PARSE time, so every consumer fails closed before a single byte is written.
//
// Round 3: flow brackets pair BY TYPE — `{a: b]` / `[a, b}` are refused (the
// host yaml rejects mismatched flow brackets; the old mixed depth counter
// accepted them and wrote an unloadable file). Properly nested single-line
// flow collections (`[{a: 1}]`, `{a: [b, c]}`) decode exactly like the host.
// Double-quoted scalars decode the host's common escape set
// (`\n \t \r \" \\ \0 \b \f \xXX \uXXXX \UXXXXXXXX`); any other escape
// REFUSES (conservative — the host either decodes it to a different
// character or rejects the document). Numeric-form KEYS outside the plain
// integer/decimal domain (`1e3`, `0x1F`, `1.`, `.5`, `.inf`, …) are refused,
// and numeric-form strings are QUOTED on write-back, so a rewritten value is
// never re-read by the host as a number.
//
// Editing strategy: never re-serialize the document. Each settings op becomes
// one original-line-range replacement computed from a fresh parse, so every
// untouched line (comments, formatting, other providers) survives
// byte-for-byte. Each op's candidate text is re-parsed and compared against a
// plain-tree simulation of that op before the next op runs; any mismatch
// refuses the write with zero side effects (the caller only ever sees the
// candidate text, never a partial file).
//
// `!!js` expressions, block scalars and quoted multi-line scalars are kept as
// opaque leaves: their raw lines are preserved verbatim but carry no value.
// An opaque leaf anywhere inside the `llm-pi-ai` providers tree makes every
// op refuse (validation would be unsound there). No timer, no network, no
// real ~/.dsh lives here — all I/O goes through the injected filesystem
// subset.

import { createHash } from 'node:crypto'
import type { SettingsDescriptor, SettingsMutationOp, SettingsService } from './writer.ts'

// ---------------------------------------------------------------------------
// Injectable filesystem subset
// ---------------------------------------------------------------------------

/** The filesystem surface this module needs (tests inject a temp-dir impl). */
export interface PatchFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string, mode?: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  stat(path: string): Promise<{ mode: number } | undefined>
}

// ---------------------------------------------------------------------------
// Parsed tree
// ---------------------------------------------------------------------------

/** One `key: value` row of a block map, with its exact original line range. */
export interface PatchMapEntry {
  key: string
  value: PatchNode
  /** Inclusive 0-based first line (the `key:` line). */
  startLine: number
  /** Inclusive 0-based last line (the value's last line). */
  endLine: number
}

/** One item of a block sequence, with its exact original line range. */
export interface PatchSeqItem {
  node: PatchNode
  startLine: number
  endLine: number
}

export type PatchNode =
  | { kind: 'map'; indent: number; entries: PatchMapEntry[]; startLine: number; endLine: number }
  | { kind: 'seq'; indent: number; items: PatchSeqItem[]; startLine: number; endLine: number }
  | { kind: 'scalar'; value: unknown; startLine: number; endLine: number }
  | { kind: 'opaque'; startLine: number; endLine: number }

export type PatchParseResult =
  | { ok: true; root: PatchNode }
  | { ok: false; reason: string }

const LLM_PI_AI_ENTRY_ID = 'llm-pi-ai'

/** The KEY regex every block-map row must match (keys are simple identifiers in practice). */
const KEY_ENTRY = /^(\S[^:]*?):(?:[ \t]+(.*))?$/

/**
 * Refuse any mapping key this subset parser and the host yaml could disagree
 * on. A key is accepted only as a BARE plain scalar: no quotes, no whitespace,
 * no YAML indicator characters, and no merge key. The host (yaml@2) parses
 * each of these shapes differently than this parser — or rejects the document
 * outright (duplicate keys) — so an edit that survived here used to write a
 * file the host could not load while the batch reported SUCCESS. Failing the
 * PARSE makes every consumer fail closed: no descriptor, no ops, no write.
 */
function keyRefusal(key: string, lineNo: number): string | undefined {
  if (key === '<<') return `line ${lineNo}: merge key "<<" is not supported`
  if (key.startsWith('"') || key.startsWith("'")) {
    return `line ${lineNo}: quoted key ${JSON.stringify(key)} is not supported (bare plain keys only)`
  }
  if (/\s/.test(key)) return `line ${lineNo}: key ${JSON.stringify(key)} contains whitespace (bare plain keys only)`
  if (/[#*&{[]/.test(key)) {
    return `line ${lineNo}: key ${JSON.stringify(key)} contains a YAML indicator character (#*&{[); refusing to guess`
  }
  // Review M3: the host yaml resolves keys to scalars before folding them into
  // a mapping — `true`/`True`/`TRUE`, `null`/`Null`/`~` and `1`/`+1`/`007` are
  // each THE SAME key, so two same-level spellings make the host reject the
  // whole document ("Map keys must be unique") while this parser sees distinct
  // strings. A single non-string key would still disagree with the string view
  // here. Refused outright instead of guessed.
  const decoded = decodePlainScalar(key)
  if (decoded === null || typeof decoded === 'boolean' || typeof decoded === 'number') {
    return `line ${lineNo}: key ${JSON.stringify(key)} resolves to a non-string (${String(decoded)}) in the host yaml; null/~/true/1 spellings collide into one key`
  }
  // Round 3: also refuse the host's wider numeric domain (1e3/0x1F/1./.5/
  // .inf/.NaN/0o17/…) — decodePlainScalar sees a string there while the host
  // yaml folds the KEY into a number, so same-level spellings collide and the
  // parser's string view diverges from the host's.
  if (hostNumberForm(key)) {
    return `line ${lineNo}: key ${JSON.stringify(key)} is numeric-form (the host yaml resolves it to a number, folding same-level spellings into one key); refusing`
  }
  return undefined
}

/** True when a plain scalar/flow part is a YAML anchor (`&name`) or alias (`*name`). */
function isAnchorOrAlias(text: string): boolean {
  return text.startsWith('&') || text.startsWith('*')
}

class TabIndentError extends Error {
  override name = 'TabIndentError'
}

function indentOf(line: string): number {
  let count = 0
  for (const ch of line) {
    if (ch === ' ') count += 1
    else if (ch === '\t') throw new TabIndentError()
    else break
  }
  return count
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function leadingSpaces(text: string): number {
  let count = 0
  while (count < text.length && text[count] === ' ') count += 1
  return count
}

function decodePlainScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^[-+]?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

/**
 * The scalar forms the host yaml@2 resolves to a NUMBER beyond the plain
 * integer/decimal pair already handled by `decodePlainScalar` (differential-
 * probed against the host closure's yaml@2.9.1): scientific notation
 * (incl. `1.e3` / `.5e2`), trailing/leading-dot decimals, LOWERCASE-prefix
 * hex/octal integers (the host keeps `0X1F`/`0O17` strings), and `.inf`/
 * `.nan` spellings. Used to refuse numeric-form KEYS (the host folds them
 * like `1`/`007`) and to QUOTE numeric-form strings on write-back (a plain
 * `1e3` would be re-read by the host as the number 1000).
 */
function hostNumberForm(text: string): boolean {
  return /^[-+]?\d+$/.test(text)
    || /^[-+]?\d+\.\d+$/.test(text)
    || /^[-+]?\d+\.$/.test(text)
    || /^[-+]?\.\d+$/.test(text)
    || /^[-+]?\d+(\.\d+)?[eE][-+]?\d+$/.test(text)
    || /^[-+]?\d+\.[eE][-+]?\d+$/.test(text)
    || /^[-+]?\.\d+[eE][-+]?\d+$/.test(text)
    || /^0x[0-9a-fA-F]+$/.test(text)
    || /^0o[0-7]+$/.test(text)
    || /^\.(inf|Inf|INF)$/.test(text)
    || /^[-+]?\.(inf|Inf|INF)$/.test(text)
    || /^\.(nan|NaN|NAN)$/.test(text)
}

/** Strip one trailing ` #comment` from a plain scalar (values keep their own `#`). */
function stripTrailingComment(raw: string): string {
  const index = raw.indexOf(' #')
  return index >= 0 ? raw.slice(0, index) : raw
}

/** Index of the closing quote scanning from `from` ('' doubling / "\" escaping handled). */
function findClosingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (quote === '"' && ch === '\\') { i += 1; continue }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
      return i
    }
  }
  return -1
}

/**
 * Index of the closing bracket for a single-line flow collection, -1 when
 * absent. Round-3 blocker: brackets pair BY TYPE (a stack of open chars), so
 * `{a: b]` / `[a, b}` / `[{a: 1]]` no longer "resolve" — the host yaml
 * rejects mismatched flow brackets outright and the old mixed depth counter
 * accepted exactly those unloadable documents (migrate-go reported SUCCESS
 * while the host refused to load the written file). A type mismatch THROWS
 * with the line number so the parse fails with the precise reason; the
 * caller only ever splices with a correctly matched close index.
 */
function matchingFlowClose(text: string, from: number, lineNo: number): number {
  const stack: string[] = [text[from]!]
  let quote: string | undefined
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== undefined) {
      if (quote === '"' && ch === '\\') { i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[' || ch === '{') { stack.push(ch); continue }
    if (ch === ']' || ch === '}') {
      const opened = stack.pop()
      const wanted = ch === ']' ? '[' : '{'
      if (opened !== wanted) {
        throw new Error(`line ${lineNo}: flow collection opened with "${opened}" but closed with "${ch}" — the host yaml rejects mismatched flow brackets; refusing`)
      }
      if (stack.length === 0) return i
    }
  }
  return -1
}

/**
 * Decode ONE single-line quoted scalar the way the host yaml@2 would
 * (round 3): single quotes only collapse `''`; double quotes decode
 * left-to-right over the host's common escape set
 * (`\n \t \r \" \\ \0 \b \f \xXX \uXXXX \UXXXXXXXX`). ANY other escape
 * REFUSES: the host either decodes it to a different character (`\a`, `\v`,
 * `\/`, `\N`, …) or rejects the document (`\q`, truncated hex, `\U` beyond
 * U+10FFFF) — writing the escape through as literal text would silently flip
 * the host's reading of the rewritten value. Multi-line quoted scalars never
 * reach here (they are opaque leaves upstream), so no line-fold/continuation
 * handling applies: refusing to decode what cannot be seen IS the
 * host-consistent continuation behavior of this subset.
 */
function unquoteYaml(text: string, lineNo: number): string {
  const quote = text[0]!
  const inner = text.slice(1, -1)
  if (quote !== '"') return inner.replaceAll("''", "'")
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch !== '\\') { out += ch; continue }
    const code = inner[i + 1]
    switch (code) {
      case '0': out += '\0'; i += 1; break
      case 'b': out += '\b'; i += 1; break
      case 'f': out += '\f'; i += 1; break
      case 'n': out += '\n'; i += 1; break
      case 'r': out += '\r'; i += 1; break
      case 't': out += '\t'; i += 1; break
      case '"': out += '"'; i += 1; break
      case '\\': out += '\\'; i += 1; break
      case 'x':
      case 'u':
      case 'U': {
        const width = code === 'x' ? 2 : code === 'u' ? 4 : 8
        const digits = inner.slice(i + 2, i + 2 + width)
        if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) {
          throw new Error(`line ${lineNo}: invalid "\\${code}" escape in a double-quoted scalar (exactly ${width} hex digits required); refusing`)
        }
        const value = Number.parseInt(digits, 16)
        if (value > 0x10ffff) {
          throw new Error(`line ${lineNo}: "\\U" escape beyond U+10FFFF is rejected by the host yaml; refusing`)
        }
        out += String.fromCodePoint(value)
        i += 1 + width
        break
      }
      default:
        throw new Error(`line ${lineNo}: unsupported escape sequence "\\${code ?? ''}" in a double-quoted scalar — the host yaml decodes it differently (or rejects the document); refusing instead of writing a value the host would read differently`)
    }
  }
  return out
}

/**
 * True when a plain (non-quoted) text carries a mapping indicator the host
 * yaml would act on: a colon followed by space/tab, or a colon at the end.
 * Both parse as a nested / single-pair mapping — never as part of a plain
 * scalar (review M1 flow single-pair items, review M2 value position).
 */
function hasMappingIndicator(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue
    const next = text[i + 1]
    if (next === undefined || next === ' ' || next === '\t') return true
  }
  return false
}

/**
 * Split a single-line flow-collection body into its top-level parts,
 * quote-, escape- and bracket-depth-aware (the old splitter mis-tracked
 * `\"` escapes and silently dropped empty entries). Commas and the
 * empty-entry check only act at depth 0, so nested `[`/`{` spans survive as
 * one part and recursion decodes them (round 3: nested single-line flow
 * collections decode like the host instead of being refused). Refuses what
 * the host cannot load or would read differently (review M1/M2):
 * - an empty entry between depth-0 commas (`[a, , b]` — the host rejects the
 *   file)
 * - a `#` outside a quoted span at any depth (a comment inside the brackets
 *   swallows the closing bracket for the host — again an unloadable
 *   document; a `#` GLUED into a plain part like `a#b` is not a comment and
 *   stays legal)
 */
function scanFlowParts(inner: string, lineNo: number): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  let prev = ''
  let depth = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (quote !== undefined) {
      current += ch
      if (quote === '"' && ch === '\\') {
        i += 1
        const escaped = inner[i] ?? ''
        current += escaped
        prev = escaped
        continue
      }
      if (ch === quote) quote = undefined
      prev = ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; prev = ch; continue }
    if (ch === '[' || ch === '{') { depth += 1; prev = ch; current += ch; continue }
    if (ch === ']' || ch === '}') { depth -= 1; prev = ch; current += ch; continue }
    if (ch === '#' && (prev === '' || /\s/.test(prev) || ',{}[]:'.includes(prev))) {
      throw new Error(`line ${lineNo}: a comment inside a flow collection swallows the closing bracket for the host yaml; refusing`)
    }
    if (ch === ',' && depth === 0) {
      if (current.trim() === '') throw new Error(`line ${lineNo}: empty flow entry (the host yaml rejects "[a, , b]")`)
      parts.push(current)
      current = ''
      prev = ','
      continue
    }
    prev = ch
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

/**
 * Decode ONE flow scalar exactly the way the host yaml would (review M1):
 * quoted scalars go through the SAME `unquoteYaml` path as the block
 * position (single/double quotes, `''` and the round-3 double-quote escape
 * domain), and a bracket-led item is a nested flow collection decoded by
 * recursion (round 3) — the host parses `[{a: 1}]` as `[{a: 1}]`, not as
 * text, so refusing it would diverge from the tree the host sees. Tags,
 * single-pair entries and anchors/aliases are REFUSED — decoding them as
 * text is what used to turn `input: ["text"]` into `["\"text\""]` on
 * write-back.
 */
function decodeFlowScalar(item: string, lineNo: number, where: string, colonMeaning: string): unknown {
  if (item.startsWith('!')) {
    throw new Error(`line ${lineNo}: YAML tags inside a ${where} are not supported (a tagged leaf cannot be carried in the subset tree; refusing instead of guessing)`)
  }
  if (isAnchorOrAlias(item)) {
    throw new Error(`line ${lineNo}: YAML anchors/aliases are not supported (in a ${where})`)
  }
  if (item.startsWith('"') || item.startsWith("'")) {
    const quote = item[0]!
    const close = findClosingQuote(item, 1, quote)
    if (close < 0) throw new Error(`line ${lineNo}: unterminated quoted scalar in a ${where}`)
    if (item.slice(close + 1).trim() !== '') {
      throw new Error(`line ${lineNo}: unexpected content after a quoted scalar in a ${where}`)
    }
    return unquoteYaml(item, lineNo)
  }
  if (item.startsWith('[') || item.startsWith('{')) {
    const close = matchingFlowClose(item, 0, lineNo)
    if (item.slice(close + 1).trim() !== '') {
      throw new Error(`line ${lineNo}: unexpected content after a flow collection in a ${where}`)
    }
    return parseFlow(item, lineNo)
  }
  if (hasMappingIndicator(item)) {
    throw new Error(`line ${lineNo}: ${colonMeaning}; refusing instead of guessing`)
  }
  return decodePlainScalar(item)
}

/**
 * Single-line flow parser (`[]`, `{}`, `[a, b]`, `{k: v}` and properly
 * nested combinations since round 3). The outer bracket TYPE pair is
 * validated first (round-3 blocker: the old `slice(1, -1)` never checked,
 * so `{a: b]` decoded as the map `{a: b}` while the host yaml rejected the
 * whole document).
 */
function parseFlow(text: string, lineNo: number): unknown {
  const trimmed = text.trim()
  if (trimmed === '[]') return []
  if (trimmed === '{}') return {}
  const open = trimmed[0]!
  const close = trimmed[trimmed.length - 1]!
  if (!((open === '[' && close === ']') || (open === '{' && close === '}'))) {
    throw new Error(`line ${lineNo}: flow collection opened with "${open}" but closed with "${close}" — the host yaml rejects mismatched flow brackets; refusing`)
  }
  const inner = trimmed.slice(1, -1)
  if (open === '[') {
    if (inner.trim() === '') return []
    return scanFlowParts(inner, lineNo).map((part) =>
      decodeFlowScalar(
        part.trim(),
        lineNo,
        'flow sequence item',
        'a single-pair flow entry like "[a: b]" (the host yaml parses it as a mapping, not a string)',
      ))
  }
  const out: Record<string, unknown> = {}
  for (const part of scanFlowParts(inner, lineNo)) {
    const match = KEY_ENTRY.exec(part.trim())
    if (match === null) throw new Error(`line ${lineNo}: unsupported flow mapping entry`)
    const key = match[1]!.trim()
    const keyLine = keyRefusal(key, lineNo)
    if (keyLine !== undefined) throw new Error(keyLine)
    if (key in out) throw new Error(`line ${lineNo}: duplicate key ${JSON.stringify(key)} in the same mapping`)
    const value = (match[2] ?? '').trim()
    out[key] = decodeFlowScalar(
      value,
      lineNo,
      'flow mapping value',
      'a nested mapping inside a flow collection ("{a: b: c}" — the host yaml rejects the whole document)',
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class PatchParser {
  private readonly lines: string[]

  constructor(lines: string[]) {
    this.lines = lines
  }

  private nextStructural(from: number): number | undefined {
    for (let i = from; i < this.lines.length; i++) {
      if (!isSkippable(this.lines[i]!)) return i
    }
    return undefined
  }

  /** Last line of a value blob: deeper-indented continuation lines (blank lines kept only when the blob continues past them). */
  private consumeDeeper(startLine: number, entryIndent: number): number {
    let end = startLine
    let i = startLine + 1
    while (i < this.lines.length) {
      const line = this.lines[i]!
      if (line.trim() === '') {
        let j = i + 1
        while (j < this.lines.length && this.lines[j]!.trim() === '') j += 1
        if (j < this.lines.length && indentOf(this.lines[j]!) > entryIndent) { end = i; i += 1; continue }
        break
      }
      if (indentOf(line) > entryIndent) { end = i; i += 1; continue }
      break
    }
    return end
  }

  /** Lines of a quoted scalar that continues past its opening line; fails loudly on dedent. */
  private consumeQuoted(startLine: number, entryIndent: number, quote: string, fromCol: number): number {
    let from = fromCol
    for (let i = startLine; i < this.lines.length; i++) {
      const line = this.lines[i]!
      const close = findClosingQuote(line, i === startLine ? from : 0, quote)
      if (close >= 0) return i
      const next = i + 1
      if (next < this.lines.length) {
        const nextLine = this.lines[next]!
        if (nextLine.trim() !== '' && indentOf(nextLine) <= entryIndent) {
          throw new Error(`line ${next + 1}: unterminated quoted scalar`)
        }
      }
    }
    throw new Error(`line ${startLine + 1}: unterminated quoted scalar`)
  }

  /** Parse an inline value; multi-line shapes become opaque leaves over their raw lines. */
  private parseInlineValue(rawValue: string, lineIdx: number, entryIndent: number): { node: PatchNode; endLine: number } {
    const trimmed = rawValue.trim()
    const line = this.lines[lineIdx]!
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      const quote = trimmed[0]!
      const openCol = line.indexOf(quote)
      const closeCol = findClosingQuote(line, openCol + 1, quote)
      if (closeCol >= 0) {
        const after = line.slice(closeCol + 1).trim()
        if (after !== '' && !after.startsWith('#')) throw new Error(`line ${lineIdx + 1}: unexpected content after a quoted scalar`)
        return {
          node: { kind: 'scalar', value: unquoteYaml(line.slice(openCol, closeCol + 1), lineIdx + 1), startLine: lineIdx, endLine: lineIdx },
          endLine: lineIdx,
        }
      }
      const end = this.consumeQuoted(lineIdx, entryIndent, quote, openCol + 1)
      return { node: { kind: 'opaque', startLine: lineIdx, endLine: end }, endLine: end }
    }
    // Anchors/aliases are refused anywhere in a value position: this parser
    // would decode `models: *m` as the literal string "*m" while the host yaml
    // resolves the alias — an edit validated against the wrong tree used to
    // pass self-validation and write a semantically different document.
    // (Quoted values starting with & or * were already handled above.)
    if (isAnchorOrAlias(trimmed)) {
      throw new Error(`line ${lineIdx + 1}: YAML anchors/aliases are not supported (value starts with '${trimmed[0]}')`)
    }
    if (trimmed.startsWith('!')) {
      const end = this.consumeDeeper(lineIdx, entryIndent)
      return { node: { kind: 'opaque', startLine: lineIdx, endLine: end }, endLine: end }
    }
    if (/^[|>][+-]?[0-9]*(#.*)?$/.test(trimmed)) {
      const end = this.consumeDeeper(lineIdx, entryIndent)
      return { node: { kind: 'opaque', startLine: lineIdx, endLine: end }, endLine: end }
    }
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const openCol = line.indexOf(trimmed[0]!)
      const closeCol = matchingFlowClose(line, openCol, lineIdx + 1)
      if (closeCol < 0) throw new Error(`line ${lineIdx + 1}: multi-line flow collections are not supported`)
      const after = line.slice(closeCol + 1).trim()
      if (after !== '' && !after.startsWith('#')) throw new Error(`line ${lineIdx + 1}: unexpected content after a flow collection`)
      return {
        node: { kind: 'scalar', value: parseFlow(line.slice(openCol, closeCol + 1), lineIdx + 1), startLine: lineIdx, endLine: lineIdx },
        endLine: lineIdx,
      }
    }
    // Review M2: a colon-space (or trailing colon) in a plain VALUE position
    // parses here but the host yaml rejects the WHOLE document ("Nested
    // mappings are not allowed"). Strip the trailing comment first — only the
    // value's own colons count (`a # x: y` is a comment for the host too).
    const plain = stripTrailingComment(trimmed)
    if (hasMappingIndicator(plain)) {
      throw new Error(`line ${lineIdx + 1}: a "b: c" nested mapping in a value position is rejected by the host yaml; refusing`)
    }
    const end = this.consumeDeeper(lineIdx, entryIndent)
    if (end !== lineIdx) {
      // Multi-line PLAIN blob: the raw lines stay opaque, but a mapping
      // indicator on any continuation line still makes the file unloadable
      // for the host — refuse instead of accepting a broken document.
      for (let i = lineIdx + 1; i <= end; i++) {
        const raw = stripTrailingComment(this.lines[i]!.trim())
        if (raw === '' || raw.startsWith('#')) continue
        if (hasMappingIndicator(raw)) {
          throw new Error(`line ${i + 1}: a "b: c" nested mapping inside a plain multi-line scalar is rejected by the host yaml; refusing`)
        }
      }
      return { node: { kind: 'opaque', startLine: lineIdx, endLine: end }, endLine: end }
    }
    return {
      node: { kind: 'scalar', value: decodePlainScalar(plain), startLine: lineIdx, endLine: lineIdx },
      endLine: lineIdx,
    }
  }

  /** Parse the block starting at `start` (its first structural line, at column `indent`). */
  parseBlock(start: number, indent: number): { node: PatchNode; next: number } {
    const text = this.lines[start]!.slice(indent)
    if (text.startsWith('- ') || text === '-') return this.parseSeq(start, indent)
    const match = KEY_ENTRY.exec(text)
    if (match !== null) return this.parseMap(start, indent, { key: match[1]!, valueText: match[2] })
    throw new Error(`line ${start + 1}: unsupported YAML construct`)
  }

  private parseSeq(start: number, indent: number): { node: PatchNode; next: number } {
    const items: PatchSeqItem[] = []
    let i = start
    for (;;) {
      const at = this.nextStructural(i)
      if (at === undefined) break
      const atIndent = indentOf(this.lines[at]!)
      if (atIndent < indent) break
      if (atIndent > indent) throw new Error(`line ${at + 1}: unexpected indentation inside a sequence`)
      const rest = this.lines[at]!.slice(indent)
      if (!(rest.startsWith('- ') || rest === '-')) {
        throw new Error(`line ${at + 1}: expected a "- " sequence item`)
      }
      const content = rest === '-' ? '' : rest.slice(1 + leadingSpaces(rest.slice(1)))
      const contentCol = indent + 1 + leadingSpaces(rest.slice(1))
      if (content.trim() === '' || content.trimStart().startsWith('#')) {
        const nested = this.nextStructural(at + 1)
        if (nested !== undefined && indentOf(this.lines[nested]!) > indent) {
          const child = this.parseBlock(nested, indentOf(this.lines[nested]!))
          items.push({ node: child.node, startLine: at, endLine: child.node.endLine })
          i = child.node.endLine + 1
        } else {
          items.push({ node: { kind: 'scalar', value: null, startLine: at, endLine: at }, startLine: at, endLine: at })
          i = at + 1
        }
        continue
      }
      const keyMatch = KEY_ENTRY.exec(content)
      if (keyMatch !== null && !content.trimStart().startsWith('"') && !content.trimStart().startsWith("'")) {
        // Inline map: the first key lives on the dash line at contentCol.
        const map = this.parseMap(at, contentCol, { key: keyMatch[1]!, valueText: keyMatch[2] })
        items.push({ node: map.node, startLine: at, endLine: map.node.endLine })
        i = map.node.endLine + 1
        continue
      }
      const value = this.parseInlineValue(content, at, indent)
      items.push({ node: value.node, startLine: at, endLine: value.endLine })
      i = value.endLine + 1
    }
    if (items.length === 0) throw new Error(`line ${start + 1}: empty sequence`)
    return {
      node: { kind: 'seq', indent, items, startLine: start, endLine: items[items.length - 1]!.endLine },
      next: items[items.length - 1]!.endLine + 1,
    }
  }

  /**
   * Parse a block map whose entry rows sit at column `mapIndent`. When
   * `first` is given, the first entry was pre-matched on the `start` line
   * (which may be a sequence dash line).
   */
  private parseMap(
    start: number,
    mapIndent: number,
    first: { key: string; valueText: string | undefined },
  ): { node: PatchNode; next: number } {
    const entries: PatchMapEntry[] = []
    // Same-level duplicate keys: this parser used to fold them last-wins in
    // its plain view while the host yaml rejects the document outright — an
    // edit validated against the folded view wrote a file the host could not
    // load. Detect at parse time, per mapping level.
    const seenKeys = new Set<string>()
    let i = start
    let pending: { key: string; valueText: string | undefined; line: number } | undefined =
      { key: first.key, valueText: first.valueText, line: start }
    for (;;) {
      let keyLine: number
      let key: string
      let rawValue: string | undefined
      if (pending !== undefined) {
        keyLine = pending.line
        key = pending.key
        rawValue = pending.valueText
        pending = undefined
      } else {
        const at = this.nextStructural(i)
        if (at === undefined) break
        const atIndent = indentOf(this.lines[at]!)
        if (atIndent < mapIndent) break
        if (atIndent > mapIndent) throw new Error(`line ${at + 1}: unexpected indentation inside a mapping`)
        const match = KEY_ENTRY.exec(this.lines[at]!.slice(atIndent))
        if (match === null) throw new Error(`line ${at + 1}: expected a "key: value" mapping entry`)
        keyLine = at
        key = match[1]!
        rawValue = match[2]
        i = at
      }
      const keyProblem = keyRefusal(key, keyLine + 1)
      if (keyProblem !== undefined) throw new Error(keyProblem)
      if (seenKeys.has(key)) {
        throw new Error(`line ${keyLine + 1}: duplicate key ${JSON.stringify(key)} in the same mapping (the host yaml rejects duplicate keys)`)
      }
      seenKeys.add(key)
      if (rawValue === undefined || rawValue.trim() === '' || rawValue.trimStart().startsWith('#')) {
        const nested = this.nextStructural(keyLine + 1)
        if (nested !== undefined && indentOf(this.lines[nested]!) > mapIndent) {
          const child = this.parseBlock(nested, indentOf(this.lines[nested]!))
          entries.push({ key, value: child.node, startLine: keyLine, endLine: child.node.endLine })
          i = child.node.endLine + 1
        } else {
          entries.push({ key, value: { kind: 'scalar', value: null, startLine: keyLine, endLine: keyLine }, startLine: keyLine, endLine: keyLine })
          i = keyLine + 1
        }
      } else {
        const value = this.parseInlineValue(rawValue, keyLine, mapIndent)
        entries.push({ key, value: value.node, startLine: keyLine, endLine: value.endLine })
        i = value.endLine + 1
      }
    }
    if (entries.length === 0) throw new Error(`line ${start + 1}: empty mapping`)
    const endLine = entries[entries.length - 1]!.endLine
    return { node: { kind: 'map', indent: mapIndent, entries, startLine: start, endLine }, next: endLine + 1 }
  }
}

/**
 * Parse a profile patch document. Returns the root sequence node; every node
 * carries its exact original line range so edits splice by line numbers.
 * Anything outside the supported subset is a refusal, never a guess.
 */
export function parsePatchDocument(text: string): PatchParseResult {
  if (text.includes('\r')) return { ok: false, reason: 'CRLF line endings are not supported' }
  const lines = text.split('\n')
  try {
    let first = 0
    while (first < lines.length && isSkippable(lines[first]!)) first += 1
    if (first >= lines.length) return { ok: false, reason: 'document is empty' }
    const parser = new PatchParser(lines)
    // Minimal-patch files are an empty top-level flow sequence (`[]`).
    const firstText = lines[first]!.trim()
    if (firstText === '[]') {
      return { ok: true, root: { kind: 'seq', indent: indentOf(lines[first]!), items: [], startLine: first, endLine: first } }
    }
    const root = parser.parseBlock(first, indentOf(lines[first]!)).node
    for (let i = root.endLine + 1; i < lines.length; i++) {
      if (!isSkippable(lines[i]!)) {
        return { ok: false, reason: `line ${i + 1}: content after the root sequence is not supported` }
      }
    }
    if (root.kind !== 'seq') return { ok: false, reason: 'profile patch must be a YAML sequence of entries' }
    return { ok: true, root }
  } catch (err) {
    if (err instanceof TabIndentError) return { ok: false, reason: 'tab indentation is not supported' }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Plain view + llm-pi-ai location
// ---------------------------------------------------------------------------

/** Marker for leaves whose value could not be decoded (tags, block scalars, blobs). */
export class OpaqueValue {
  readonly opaque = true as const
}

/** Deep plain-JS view of a parsed node (opaque leaves → OpaqueValue). */
export function plainView(node: PatchNode): unknown {
  switch (node.kind) {
    case 'map': {
      const out: Record<string, unknown> = {}
      for (const entry of node.entries) out[entry.key] = plainView(entry.value)
      return out
    }
    case 'seq':
      return node.items.map((item) => plainView(item.node))
    case 'scalar':
      return node.value
    case 'opaque':
      return new OpaqueValue()
  }
}

function containsOpaque(value: unknown): boolean {
  if (value instanceof OpaqueValue) return true
  if (Array.isArray(value)) return value.some(containsOpaque)
  if (typeof value === 'object' && value !== null) return Object.values(value).some(containsOpaque)
  return false
}

function findLlmPiAiEntry(root: PatchNode): (PatchNode & { kind: 'map' }) | { refusal: string } {
  if (root.kind !== 'seq') return { refusal: 'profile patch must be a YAML sequence of entries' }
  // The host edits the LAST non-insert row carrying the entry id.
  for (let i = root.items.length - 1; i >= 0; i--) {
    const node = root.items[i]!.node
    if (node.kind !== 'map') continue
    if (node.entries.some((entry) => entry.key === 'insert')) continue
    const idEntry = [...node.entries].reverse().find((entry) => entry.key === 'id')
    if (idEntry !== undefined && idEntry.value.kind === 'scalar' && idEntry.value.value === LLM_PI_AI_ENTRY_ID) return node
  }
  return { refusal: `no "${LLM_PI_AI_ENTRY_ID}" entry found in the profile patch` }
}

interface ProvidersLocation {
  providersNode: PatchNode & { kind: 'map' }
  providersLine: number
  before: Record<string, unknown>
}

/**
 * Locate the `llm-pi-ai` providers mapping plus its plain before-value, or a
 * refusal reason. Shared by the op applier and the descriptor builder.
 */
function locateProviders(root: PatchNode): ProvidersLocation | { refusal: string } {
  const entry = findLlmPiAiEntry(root)
  if ('refusal' in entry) return { refusal: entry.refusal }
  const configEntry = [...entry.entries].reverse().find((item) => item.key === 'config')
  if (configEntry === undefined || configEntry.value.kind !== 'map') {
    return { refusal: 'the llm-pi-ai entry has no config mapping' }
  }
  const providersEntry = [...configEntry.value.entries].reverse().find((item) => item.key === 'providers')
  if (providersEntry === undefined || providersEntry.value.kind !== 'map') {
    return { refusal: 'the llm-pi-ai config has no providers mapping' }
  }
  const plain = plainView(providersEntry.value)
  if (containsOpaque(plain)) return { refusal: 'the llm-pi-ai providers tree contains opaque values (tags / block scalars); refusing to edit' }
  if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) {
    return { refusal: 'the llm-pi-ai providers section is not a mapping' }
  }
  return { providersNode: providersEntry.value, providersLine: providersEntry.startLine, before: plain as Record<string, unknown> }
}

/** The plain `providers` tree of the `llm-pi-ai` entry, or a refusal reason. */
export function patchLlmPiAiProviders(root: PatchNode): { ok: true; providers: unknown } | { ok: false; reason: string } {
  const located = locateProviders(root)
  if ('refusal' in located) return { ok: false, reason: located.refusal }
  return { ok: true, providers: located.before }
}

// ---------------------------------------------------------------------------
// YAML emission (only for the blocks this module writes)
// ---------------------------------------------------------------------------

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_\-./: ]*$/

/**
 * Render one scalar in plain-or-quoted form (double quotes, JSON escaping).
 * Round 3: any numeric-form STRING (`1e3`, `0x1F`, `1.`, `.5`, `.inf`, … as
 * well as the plain integer/decimal pair) is QUOTED — the host yaml resolves
 * those plain forms to numbers, so an unquoted write-back would silently
 * flip the value's type in the host's reading (the plain decimal exclusion
 * used to cover `42` only and let `1e3` through as a number).
 */
export function renderYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (text !== '' && text === text.trim() && PLAIN_SAFE.test(text)
    && !/^(true|false|null|~|True|False|Null|TRUE|FALSE|NULL)$/i.test(text)
    && !hostNumberForm(text)
    && !text.includes(': ') && !text.endsWith(':') && !text.includes(' #')) {
    return text
  }
  return JSON.stringify(text)
}

function isScalarValue(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object'
}

function renderBlock(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item as Record<string, unknown>)
        if (entries.length === 0) { lines.push(`${pad}- {}`); continue }
        const [firstKey, firstValue] = entries[0]!
        if (isScalarValue(firstValue)) lines.push(`${pad}- ${firstKey}: ${renderYamlScalar(firstValue)}`)
        else {
          lines.push(`${pad}- ${firstKey}:`)
          lines.push(...renderBlock(firstValue, indent + 4))
        }
        for (const [key, itemValue] of entries.slice(1)) {
          if (isScalarValue(itemValue)) lines.push(`${' '.repeat(indent + 2)}${key}: ${renderYamlScalar(itemValue)}`)
          else {
            lines.push(`${' '.repeat(indent + 2)}${key}:`)
            lines.push(...renderBlock(itemValue, indent + 4))
          }
        }
      } else {
        lines.push(`${pad}- ${renderYamlScalar(item)}`)
      }
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    const lines: string[] = []
    for (const [key, itemValue] of entries) {
      if (isScalarValue(itemValue)) lines.push(`${pad}${key}: ${renderYamlScalar(itemValue)}`)
      else {
        lines.push(`${pad}${key}:`)
        lines.push(...renderBlock(itemValue, indent + 2))
      }
    }
    return lines
  }
  return [`${pad}${renderYamlScalar(value)}`]
}

/** Render one map row (`key: scalar` or `key:` + nested block) at the given indent. */
function renderEntryLines(key: string, value: unknown, indent: number): string[] {
  if (isScalarValue(value)) return [`${' '.repeat(indent)}${key}: ${renderYamlScalar(value)}`]
  if (Array.isArray(value) && value.length === 0) return [`${' '.repeat(indent)}${key}: []`]
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) return [`${' '.repeat(indent)}${key}: {}`]
  return [`${' '.repeat(indent)}${key}:`, ...renderBlock(value, indent + 2)]
}

// ---------------------------------------------------------------------------
// Ops → candidate text (one fresh parse + validated splice per op)
// ---------------------------------------------------------------------------

export type PatchOpResult =
  | { ok: true; next: string }
  | { ok: false; reason: string }

function plainTreeOf(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>
}

/** Plain-tree simulation of one op (the expected post-op providers value). */
function simulateOneOp(before: unknown, op: SettingsMutationOp): { ok: true; result: Record<string, unknown> } | { ok: false; reason: string } {
  const root = plainTreeOf(before)
  if (op.path[0] !== 'providers' || op.path.length < 2 || op.path.length > 3) {
    return { ok: false, reason: `unsupported mutation path '${op.path.join('.')}'` }
  }
  const route = op.path[1]!
  if (op.path.length === 2) {
    if (op.op === 'unset') { delete root[route]; return { ok: true, result: root } }
    return { ok: false, reason: 'whole-provider set ops are not supported' }
  }
  const field = op.path[2]!
  if (op.op === 'unset') {
    const bucket = root[route]
    if (bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket)) delete (bucket as Record<string, unknown>)[field]
    return { ok: true, result: root }
  }
  if (root[route] === undefined || root[route] === null) root[route] = {}
  const bucket = root[route]
  if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) {
    return { ok: false, reason: `provider ${route} is not a mapping; refusing to edit` }
  }
  ;(bucket as Record<string, unknown>)[field] = structuredClone(op.value)
  return { ok: true, result: root }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (a instanceof OpaqueValue || b instanceof OpaqueValue) return false
  if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>)
    const kb = Object.keys(b as Record<string, unknown>)
    if (ka.length !== kb.length) return false
    return ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  return false
}

function spliceLines(text: string, start: number, end: number, replacement: string[]): string {
  const lines = text.split('\n')
  lines.splice(start, end - start + 1, ...replacement)
  return lines.join('\n')
}

/**
 * Apply settings-style mutation ops to the patch text WITHOUT writing. Ops
 * run one at a time against the evolving text; after each op the candidate is
 * re-parsed and its providers tree must equal the plain-tree simulation of
 * that op. Only `providers.<route>[.<field>]` set/unset paths are supported
 * (that is all the migration engine writes); everything else refuses. The
 * returned text is a full candidate document — the caller persists it.
 */
export function applyPatchOps(text: string, ops: readonly SettingsMutationOp[]): PatchOpResult {
  let current = text
  for (const op of ops) {
    const parsed = parsePatchDocument(current)
    if (!parsed.ok) return { ok: false, reason: `patch parse failed: ${parsed.reason}` }
    const located = locateProviders(parsed.root)
    if ('refusal' in located) return { ok: false, reason: located.refusal }
    const simulated = simulateOneOp(located.before, op)
    if (!simulated.ok) return { ok: false, reason: simulated.reason }
    const { providersNode, providersLine } = located
    const routeIndent = providersNode.indent + 2

    let splice: Splice | undefined
    if (op.path.length === 2 && op.op === 'unset') {
      const route = op.path[1]!
      const entry = [...providersNode.entries].reverse().find((item) => item.key === route)
      if (entry !== undefined && entry.value.kind === 'map') {
        // The splice covers the ENTRY range (key line through the value's last
        // line) — the value node alone would leave an orphan `route:` key.
        splice = { start: entry.startLine, end: entry.endLine, lines: [] }
      } else if (entry !== undefined) {
        return { ok: false, reason: `provider ${route} exists but is not a mapping` }
      }
    } else {
      const route = op.path[1]!
      const field = op.path[2]!
      const routeEntry = [...providersNode.entries].reverse().find((item) => item.key === route)
      const routeNodeRaw = routeEntry?.value
      if (routeNodeRaw !== undefined && routeNodeRaw.kind !== 'map') {
        return { ok: false, reason: `provider ${route} exists but is not a mapping` }
      }
      const routeNode = routeNodeRaw
      if (routeNode === undefined) {
        // Create the provider section with this single field, after the last
        // existing provider (or right under `providers:` when empty). The
        // route KEY sits at the providers map's own indent; renderEntryLines
        // nests the field block one level below it.
        const boundary = providersNode.entries.length === 0
          ? providersLine + 1
          : providersNode.entries[providersNode.entries.length - 1]!.endLine + 1
        splice = { start: boundary, end: boundary - 1, lines: renderEntryLines(route, { [field]: op.value }, providersNode.indent) }
      } else {
        const fieldEntry = [...routeNode.entries].reverse().find((item) => item.key === field)
        if (fieldEntry !== undefined) {
          splice = { start: fieldEntry.startLine, end: fieldEntry.endLine, lines: renderEntryLines(field, op.value, routeNode.indent) }
        } else {
          // Missing field: insert before `models` (keeps the visual order used
          // by already-migrated routes), otherwise append after the last entry.
          const modelsEntry = [...routeNode.entries].reverse().find((item) => item.key === 'models')
          const boundary = modelsEntry !== undefined ? modelsEntry.startLine : routeNode.endLine + 1
          splice = { start: boundary, end: boundary - 1, lines: renderEntryLines(field, op.value, routeIndent) }
        }
      }
    }
    if (splice === undefined) {
      // Pure no-op (unset of an absent route/field): the tree already matches.
      if (!deepEqual(simulated.result, located.before)) return { ok: false, reason: 'no-op op changed the simulated tree; refusing' }
      continue
    }
    const candidate = spliceLines(current, splice.start, splice.end, splice.lines)
    const reparsed = parsePatchDocument(candidate)
    if (!reparsed.ok) return { ok: false, reason: `edited patch failed to re-parse: ${reparsed.reason}` }
    const after = patchLlmPiAiProviders(reparsed.root)
    if (!after.ok) return { ok: false, reason: `edited patch unusable: ${after.reason}` }
    if (!deepEqual(after.providers, simulated.result)) {
      return { ok: false, reason: 'edited patch does not match the simulated result; refusing to write' }
    }
    current = candidate
  }
  return { ok: true, next: current }
}

interface Splice {
  /** Inclusive start line. */
  start: number
  /** Inclusive end line (start - 1 for a pure insertion at boundary `start`). */
  end: number
  lines: string[]
}

// ---------------------------------------------------------------------------
// File-backed SettingsService over a patch file
// ---------------------------------------------------------------------------

/**
 * The I/O surface the patch-file settings adapter needs. Reads are
 * SYNCHRONOUS on purpose: `SettingsService.describe()` is a sync contract in
 * this plugin (writer.ts), and applyMigration reads the descriptor inline
 * while building/rebuilding plans. Writes are async (atomic tmp + rename).
 */
export interface PatchFileIo {
  /** Current file text, or `undefined` when the file does not exist. */
  readText(): string | undefined
  /** Atomically replace the file (sibling temp file + rename, mode preserved). */
  writeAtomic(text: string): Promise<void>
}

/**
 * Revision for the file adapter: a stable 32-bit digest of the current file
 * content. The host's numeric revisions have no meaning across processes, so
 * content hashing is the conflict detector (applyMigration's mutateWithRetry
 * re-describes and retries once on SETTINGS_CONFLICT).
 */
function revisionOf(text: string): number {
  const digest = createHash('sha256').update(text).digest()
  const value = digest.readUInt32BE(0)
  return value === 0 ? 1 : value
}

const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'

/**
 * A SettingsService over one profile patch file. `describe()` re-reads the
 * file every call (external edits are always visible; an unreadable or
 * unparseable file yields NO descriptor, which fails closed upstream).
 * `mutate()` computes the candidate text in memory, validates it op by op,
 * then writes atomically through the injected io.
 */
export function createFilePatchSettingsService(io: PatchFileIo): SettingsService {
  return {
    describe(): SettingsDescriptor[] {
      let text: string | undefined
      try {
        text = io.readText()
      } catch {
        return [] // unreadable ⇒ no descriptor ⇒ fail closed upstream
      }
      if (text === undefined || text === '') return []
      const parsed = parsePatchDocument(text)
      if (!parsed.ok) return []
      const providers = patchLlmPiAiProviders(parsed.root)
      if (!providers.ok) return []
      return [{ ns: LLM_PI_AI_ENTRY_ID, revision: revisionOf(text), user: { providers: providers.providers } }]
    },
    async mutate(ns: string, ops: SettingsMutationOp[], expectedRevision?: number): Promise<void> {
      if (ns !== LLM_PI_AI_ENTRY_ID) throw new Error(`file patch adapter only mutates ${LLM_PI_AI_ENTRY_ID}`)
      const text = io.readText() ?? ''
      if (expectedRevision !== undefined && expectedRevision !== revisionOf(text)) {
        throw Object.assign(new Error('patch file changed since describe'), { code: SETTINGS_CONFLICT })
      }
      const applied = applyPatchOps(text, ops)
      if (!applied.ok) throw new Error(applied.reason)
      if (applied.next === text) return
      await io.writeAtomic(applied.next)
    },
  }
}
