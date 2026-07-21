# Responsive Link Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the data-link menu inside panels narrower than 240 px.

**Architecture:** Derive the rendered menu width from the current visible bounds, capped at the existing 240 px preferred width. Feed the derived width into both placement and CSS so geometry cannot diverge.

**Tech Stack:** React, TypeScript, Jest, React Testing Library

---

### Task 1: Make the link menu width responsive

**Files:**
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/components/ClusterviewPanel.test.tsx`
- Modify: `docs/design.md`

**Step 1:** Add a test with a visible width below 240 px asserting both the CSS width and positioned right edge fit the viewport.

**Step 2:** Run the focused test and confirm it fails because the menu remains 240 px wide.

**Step 3:** Compute `menuW = min(240, available visible width)` and use it for placement and rendered width.

**Step 4:** Re-run the focused test and confirm it passes, including the existing 240 px behavior at normal widths.

**Step 5:** Update the corresponding known-limitation bullet in `docs/design.md` to record the responsive-width rule.

**Step 6:** Run `npm run test:ci`, `npm run typecheck`, `npm run lint`, and `npm run build`.

**Step 7:** Commit the implementation and documentation.
