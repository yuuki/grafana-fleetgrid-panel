# Scrollable Drilldown Popover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep every drilldown metric reachable when popover content exceeds the panel height.

**Architecture:** Cap the popover's rendered height to the current visible bounds and enable vertical scrolling only when its calculated content is taller. Use the capped height for placement so the bottom edge stays visible.

**Tech Stack:** React, TypeScript, Grafana UI, Jest, React Testing Library

---

### Task 1: Add drilldown internal scrolling

**Files:**
- Modify: `src/components/DrilldownPopover.tsx`
- Test: `src/components/DrilldownPopover.test.tsx`
- Modify: `docs/design.md`

**Step 1:** Add a short-viewport test asserting max height, vertical scrolling, and in-bounds placement for tall content.

**Step 2:** Run the focused test and confirm it fails because the full content height is used.

**Step 3:** Derive available and rendered height, use rendered height in `placeOverlay`, and set border-box/max-height/overflow styles.

**Step 4:** Re-run focused tests and confirm both tall and normal popovers pass.

**Step 5:** Update the corresponding known-limitation bullet in `docs/design.md` with the new overflow behavior.

**Step 6:** Run `npm run test:ci`, `npm run typecheck`, `npm run lint`, and `npm run build`.

**Step 7:** Commit the implementation and documentation.
