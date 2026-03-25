---
description: Ask clarification questions to refine a specification before execution
---
Ask clarification questions to resolve ambiguities and tentative decisions.

**Input:** $@

If a file path was provided, read that file first. If no input was provided, ask what needs clarification.

---

## Your Task

1. **Understand the context** - Read provided file or ask for details
2. **Identify issues** - Look for:
   - Ambiguous terms or phrases
   - "TBD", "TODO", or tentative decisions
   - Multiple options without a clear choice
   - Assumptions that may not hold
   - Missing details that could block implementation

3. **Ask targeted questions** - For each issue:
   - Provide clear answer options (A/B/C)
   - Resolve binary decisions
   - Fill missing information

4. **Format questions clearly**:

## Clarification Needed

### 1. [Topic]
**Question:** [The question]
**Options:**
- A) [Option A]
- B) [Option B]
**Impact:** [Why this matters]

### 2. [Topic]
...

## Assumptions Confirmed
List assumptions that seem safe and don't need clarification.

## Ready to Proceed
Indicate which parts are clear and can proceed without changes.

---

**Important:**
- Do NOT make changes to files
- Do NOT redo previous research
- Only ask questions that affect implementation decisions
- If everything is clear, say "Ready to proceed."
- Keep questions focused on removing blockers