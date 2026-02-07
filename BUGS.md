# Voxly - Known Bugs

## Open Bugs

(None currently)

---

## Closed Bugs

### BUG-001: Stale transcript shown after failed extraction/transcription

**Status:** Fixed in v1.6.2
**Severity:** High
**Version Found:** 1.6.1
**Date Found:** 2025-02-07
**Date Fixed:** 2025-02-07

**Description:**
When Voxly fails to extract or transcribe a URL, it displays the previous transcript from storage instead of showing an error state. This gives the false impression that the transcription succeeded.

**Steps to Reproduce:**
1. Successfully transcribe a YouTube video (transcript is stored)
2. Enter a URL that cannot be transcribed (e.g., `https://podcasts.apple.com/us/podcast/crime-junkie/id1322200189`)
3. Attempt to transcribe
4. Observe: The previous transcript is displayed instead of an error

**Root Cause:**
The `showResult()` function was not being hidden on errors, and `currentResult` was not cleared at the start of new transcription attempts. The UI read from `chrome.storage.local` which contained stale data.

**Fix Applied:**
1. Added `hideResult()` function to hide the result section
2. Clear `currentResult` and `currentMetadata` at the START of all transcription functions
3. Call `hideResult()` on all error paths in:
   - `transcribeFile()`
   - `transcribeUrl()`
   - `extractYoutubeTranscript()`
