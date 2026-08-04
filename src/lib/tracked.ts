/**
 * "Have I been here before?" — asked of a page rather than of a filled form.
 *
 * The save-time duplicate check has existed since phase 2, and it answers this
 * same question far too late: by then the user has read the description, typed
 * their notes, and pressed Save. Phase 5 runs the identical machinery the moment
 * a posting is detected, which is when somebody would actually think to ask
 * (decision 7).
 *
 * The mapping lives here, in `lib`, rather than in the panel because both
 * callers need exactly the same one. The panel asks so it can show the revisit
 * banner; the worker asks so it can mark the toolbar icon. Two mappings would be
 * two definitions of what makes a detection the same posting as a record, and
 * they would drift.
 */
import type { DetectionReport, DetectionSummary } from './detection'
import { newId } from './ids'
import type { PostingInput } from './types'

/** Everything `postingInputFromDetection` reads, from either shape. */
export type DetectionIdentity = Pick<
  DetectionReport | DetectionSummary,
  'url' | 'fields' | 'source' | 'confidence' | 'adapterVersion'
>

/**
 * A detection shaped as the posting it would become, for `findDuplicate`.
 *
 * Only the four identity fields matter to the search — canonical URL, company,
 * requisition id and title — but `PostingInput` is a complete record, so the
 * rest is filled with the same neutral values a fresh form would carry. None of
 * it reaches storage: this input is a query, never written.
 *
 * `id` defaults to a fresh one because `findDuplicate` excludes the record whose
 * id it is given, so that a record cannot match itself. A detection is not a
 * record and has no id to exclude; an unused fresh one keeps every stored
 * posting eligible, which is what asking about a page means.
 */
export function postingInputFromDetection(
  detection: DetectionIdentity,
  id: string = newId(),
): PostingInput {
  const { fields } = detection

  return {
    id,
    company: fields.company ?? '',
    jobTitle: fields.jobTitle ?? '',
    location: fields.location,
    workMode: fields.workMode,
    atsReqId: fields.atsReqId,
    salary: fields.salary,
    // Reported by the content script from its own `location.href`, so this is
    // the most trustworthy field in the message (decision 2).
    url: detection.url,
    source: detection.source,
    sourceConfidence: detection.confidence,
    adapterVersion: detection.adapterVersion,
    state: 'viewed',
    appliedAt: null,
    stage: null,
    outcome: null,
    resumeUsed: null,
    notes: null,
    tags: [],
  }
}

/**
 * Marks the toolbar icon for a tab showing a posting that is already tracked.
 *
 * Per-tab rather than global, which is what makes this correct without any
 * bookkeeping: Chrome scopes a tab-scoped badge to that tab, so switching tabs
 * shows the right answer with nothing to clear, and a tab closing takes its
 * badge with it. A global badge would need every tab switch to repaint it, and
 * would be wrong in the gap.
 *
 * No permission is involved. `action` is already declared, and setting a badge
 * on a tab id reveals nothing about that tab (decision 2) — the answer came from
 * the extension's own records, not from reading the page.
 */
export async function setTrackedBadge(tabId: number, tracked: boolean): Promise<void> {
  // A glyph rather than a count. The question is "have I been here", which is
  // yes or no; a number would invite reading it as how many times.
  await chrome.action.setBadgeText({ tabId, text: tracked ? '✓' : '' })

  if (!tracked) return

  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1f6f4a' })
}
