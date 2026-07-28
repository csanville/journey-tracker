/**
 * Company name normalization — a join key, not a display value (decision 7).
 *
 * The same employer is written a dozen ways across job boards: "Acme, Inc.",
 * "ACME Incorporated", "Acme Inc". Dedupe and any future join against the
 * Gmail-derived tracker both need those to land on one string, so this is a real
 * implementation rather than a trim.
 *
 * The governing asymmetry: **a wrong merge is worse than a missed one.** Two
 * records that should have collapsed are a visible duplicate the user can see
 * and fix. Two different employers collapsed into one silently corrupts every
 * count downstream, and nothing in the UI would reveal it. So this strips only
 * what is unambiguously a legal form or punctuation, and deliberately leaves
 * name-bearing words alone — "Acme Group" and "Acme" stay distinct, because
 * sometimes they genuinely are.
 *
 * The output is for indexing and comparison only. `company` keeps whatever the
 * page said, and that is what the UI shows.
 */

/**
 * Legal-form tokens, stripped only from the end of the name.
 *
 * Everything here denotes incorporation rather than identity. Notably absent:
 * `group`, `holdings`, `partners`, `labs`, `studio`, `ventures` — those routinely
 * distinguish one real entity from another and stripping them merges companies
 * that are not the same.
 */
const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'pllc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'plc',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'mbh',
  'ug',
  'kg',
  'ohg',
  'ag',
  'sa',
  'sas',
  'sarl',
  'sl',
  'srl',
  'spa',
  'nv',
  'bv',
  'ab',
  'oy',
  'oyj',
  'as',
  'asa',
  'aps',
  'pty',
  'pte',
  'pvt',
  'kk',
  'kft',
  'doo',
  'zoo',
  'pc',
  'psc',
])

/**
 * Names that are genuinely the same employer written two ways.
 *
 * Long form on the left, the form people actually use on the right. Kept small
 * and explicit on purpose: every entry is a hand-checked assertion that two
 * strings mean one company, and a wrong one is exactly the silent bad merge this
 * module exists to avoid. Applied after suffix stripping, so "Ernst & Young LLP"
 * has already become "ernst and young" by the time it is looked up.
 */
const ALIASES = new Map<string, string>([
  ['international business machines', 'ibm'],
  ['hewlett packard', 'hp'],
  ['hewlett packard enterprise', 'hpe'],
  ['american express', 'amex'],
  ['pricewaterhousecoopers', 'pwc'],
  ['price waterhouse coopers', 'pwc'],
  ['ernst and young', 'ey'],
  ['deloitte touche tohmatsu', 'deloitte'],
  ['meta platforms', 'meta'],
])

/**
 * Folds case and accents, turns punctuation into word breaks, and splits.
 *
 * `&` becomes the word "and" rather than vanishing, so "Johnson & Johnson" and
 * "Johnson and Johnson" agree. Non-Latin scripts survive: the separator class is
 * "not a letter or number" in the Unicode sense, not "not ASCII".
 */
function tokenize(raw: string): string[] {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Joins runs of single-character tokens, so initialisms written with periods
 * survive punctuation stripping: "S.p.A." arrives here as `s p a` and leaves as
 * `spa`, which the suffix list can then recognise. Same for `L.L.C.`, `N.V.`,
 * `A.G.` — and for names that really are initials, like H-E-B.
 */
function joinInitialisms(tokens: string[]): string[] {
  const out: string[] = []
  let run: string[] = []

  const flush = () => {
    if (run.length > 1) out.push(run.join(''))
    else if (run.length === 1) out.push(run[0]!)
    run = []
  }

  for (const token of tokens) {
    if (token.length === 1) run.push(token)
    else {
      flush()
      out.push(token)
    }
  }
  flush()

  return out
}

/**
 * Drops trailing legal forms, repeatedly — "Acme Co., Ltd." sheds both.
 *
 * Never returns empty: a name made entirely of legal-form words ("Limited") is
 * that company's actual name, and an empty join key would collapse it with every
 * other such record.
 */
function stripLegalSuffixes(tokens: string[]): string[] {
  let end = tokens.length
  while (end > 1 && LEGAL_SUFFIXES.has(tokens[end - 1]!)) end--
  return tokens.slice(0, end)
}

/**
 * Reduces a company name to its join key.
 *
 * Returns an empty string only for input with no letters or digits at all,
 * which callers should treat as "no company known" rather than as a key.
 */
export function normalizeCompany(raw: string): string {
  let tokens = joinInitialisms(tokenize(raw))
  if (tokens.length === 0) return ''

  // "The Boeing Company" and "Boeing" are the same employer.
  if (tokens.length > 1 && tokens[0] === 'the') tokens = tokens.slice(1)

  const key = stripLegalSuffixes(tokens).join(' ')

  return ALIASES.get(key) ?? key
}
