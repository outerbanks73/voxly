# Voxly - Known Bugs

## Open Bugs

### BUG-001: Stale transcript shown after failed extraction/transcription

**Status:** Open
**Severity:** High
**Version Found:** 1.6.1
**Date:** 2025-02-07

**Description:**
When Voxly fails to extract or transcribe a URL, it displays the previous transcript from storage instead of showing an error state. This gives the false impression that the transcription succeeded.

**Steps to Reproduce:**
1. Successfully transcribe a YouTube video (transcript is stored)
2. Enter a URL that cannot be transcribed (e.g., `https://podcasts.apple.com/us/podcast/crime-junkie/id1322200189`)
3. Attempt to transcribe
4. Observe: The previous transcript is displayed instead of an error

**Expected Behavior:**
- Show clear error message indicating the URL cannot be transcribed
- Do NOT display any previous transcript data
- Clear the result area or show empty state

**Root Cause:**
The `showResult()` function is called even after errors, or `currentResult` is not properly cleared on failure. The UI reads from `chrome.storage.local` which contains stale data.

**Files Involved:**
- `extension/sidepanel.js` - Error handling in `transcribeUrl()`, `extractYoutubeTranscript()`
- `extension/transcript.js` - Result display logic

**Proposed Fix:**
1. Clear `currentResult` and `currentMetadata` at the START of any new transcription attempt
2. Only call `showResult()` on actual success
3. On error, explicitly clear the result display area
4. Consider adding a "source URL" check to prevent showing mismatched transcripts

---

## Closed Bugs

(None yet)
