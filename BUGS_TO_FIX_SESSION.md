# CRITICAL BUGS — AUTH SYSTEM LIVE

**Status:** Blocking production testing  
**Priority:** 🔴 CRITICAL  
**Timeline:** After edit is approved and user completes upload flow

---

## BUG #1: EDIT + APPROVE SHOWS "BLOCKED" ❌

### Problem
1. User uploads invoice
2. Field shows "not detected" or wrong value
3. User edits the field on results page
4. User clicks "Approve"
5. **Result:** Shows "❌ Blocked" instead of posting with edited value

### Expected
- Edited field should be accepted
- Invoice should post to Xero/QB with edited value
- Should show "✅ Approved"

### Root Cause
When validation runs after edit, it's rejecting the edited value (might be treating it as still invalid, or validation logic is wrong).

### Fix Required
1. When user edits a field, mark it as "user-verified" (skip confidence checks)
2. On approve, use edited value + skip re-validation
3. Post to Xero/QB with edited value
4. Show "✅ Approved" not "❌ Blocked"

---

## BUG #2: OAUTH CONNECTION LOST AFTER UPLOAD ❌

### Problem
1. User on dashboard → "✅ Xero Connected (My Business Ltd)"
2. User uploads 2 invoices/receipts
3. Taken to results page (shows pending documents to approve/edit)
4. User approves invoices
5. User refreshes OR goes back to dashboard
6. **Result:** Connection gone → "❌ Not Connected"

### Expected
- Connection should persist across page navigation
- Should still show "✅ Xero Connected" after upload
- Approval should not clear the OAuth token

### Root Cause
OAuth token is being cleared somewhere in the upload/approval flow, or session is not persisting properly.

### Fix Required
1. Check: Is OAuth token being deleted during upload?
2. Check: Is session being cleared after approval?
3. Ensure `getConnectionStatus()` is reading fresh token from database
4. Don't clear tokens on upload/approval (only on explicit disconnect)

---

## BUG #3: NO NAVIGATION AFTER APPROVAL ❌

### Problem
1. User approves invoice(s)
2. Page shows approval result (✅ or ❌)
3. **No way to navigate back to dashboard except refresh**
4. User is stuck on results page

### Expected
- Show "✅ Approval Complete" message
- Show button: "Back to Dashboard" OR "Upload More" OR "View Pending"
- Let user navigate without refreshing

### Root Cause
No navigation button/link after approval flow completes.

### Fix Required
1. Add "Back to Dashboard" button after approval completes
2. Add "Upload More Documents" button (return to upload page)
3. Add "View Pending Queue" button (show all pending invoices)
4. At least one of these should be visible after approval

---

## SUMMARY

| Bug | Impact | Fix Complexity |
|---|---|---|
| Edit + Approve blocked | Edited invoices rejected | Medium (validation logic) |
| OAuth lost after upload | Connection disappears, looks broken | Medium (token lifecycle) |
| No navigation post-approval | User stuck, must refresh | Low (add buttons) |

---

## BRIEF FOR CLAUDE CODE

Fix these three bugs:

1. **Edit validation:** When user edits a field and approves, don't re-validate (treat as user-verified). Use edited value for posting.

2. **OAuth persistence:** Don't clear OAuth tokens during upload/approval flow. Ensure session stays valid across page navigation. Only clear on explicit disconnect.

3. **Post-approval navigation:** After approval completes, show buttons: "Back to Dashboard", "Upload More", "View Pending Queue". User shouldn't need to refresh.

See BUGS_TO_FIX_SESSION.md for details.