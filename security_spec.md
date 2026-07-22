# Firestore Security Specification

## 1. Data Invariants
- Anyone can read the `/stats/visitors` document to show the real-time visitor count.
- Unauthenticated and authenticated users alike can increment the visitor count under `/stats/visitors` by exactly `1` per request.
- Users cannot set the count arbitrarily (e.g., they cannot jump from 10 to 1,000,000). That is blocked.
- Users cannot delete the stats.
- Visitors cannot write any other field except `count` and optionally `updatedAt` (set to the server request time).

## 2. The "Dirty Dozen" Payloads
These payloads attempt to breach identity, integrity, or system state:
1. **Arbitrary Write**: Creating random fields on `/stats/visitors` (e.g. `{ isAdmin: true }`).
2. **Jump Increment**: Attempting to set `count` to an arbitrary big number (e.g. `{ count: 999999 }`).
3. **Negative Increment**: Decrementing the counter (e.g. `{ count: -5 }` or `count: resource.data.count - 1`).
4. **Delete Check**: Authenticated or anonymous users trying to delete `/stats/visitors`.
5. **Collection Creation**: Setting document under a random administrative collection `/admins/xxx`.
6. **Path Poisoning**: Passing a corrupted string as the stats document ID to trigger injection.
7. **Bypass Temporal Rule**: Setting `updatedAt` to a client timestamp instead of `request.time`.
8. **Malicious Zeroing**: Attempting to set `count` to `0` or nullifying it.
9. **Fake Field Update**: Attempting to update `count` by a float increment, or adding non-numerical values.
10. **Admin Claim Bypass**: Modifying document settings assuming admin rights without being in `/admins/xxx`.
11. **PII Modification**: Attempting to inject email/private variables into visitor stats.
12. **Double increment**: Attempting to increment by `2` or more.

## 3. The Test Runner
```typescript
// firestore.rules.test.ts
// Synthesized unit tests validating permissions and prevention of unauthorized edits
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

// Tests will verify that all unauthorized payloads return PERMISSION_DENIED.
```
