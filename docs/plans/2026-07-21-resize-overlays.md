# Resize-aware Overlay Placement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reposition an open drilldown popover or link menu when the panel size changes.

**Architecture:** Keep the click origin in content coordinates, but store visible bounds separately from overlay state and measure them from the current scroll container dimensions. Measure synchronously on click for initial placement, then remeasure after resized panel props commit in a layout effect; observe later container-only size changes when `ResizeObserver` is available.

**Tech Stack:** React, TypeScript, Jest, React Testing Library

---

### Task 1: Recompute overlay bounds on resize

**Files:**
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/components/ClusterviewPanel.test.tsx`
- Modify: `docs/design.md`

**Step 1:** Add rerender tests that open each overlay, shrink the mocked visible box and panel props, and assert the open overlay is repositioned within the new bounds.

**Step 2:** Run the focused tests and confirm they fail because bounds are stored at click time.

**Step 3:** Add a scroll-container ref, store only overlay payload/origin, and measure current bounds on click and after DOM commit. Update bounds only when a measurement changes, add a safe `ResizeObserver` fallback, and preserve scroll-close behavior.

**Step 4:** Re-run focused tests and existing scrolling/placement tests.

**Step 5:** Update the corresponding known-limitation bullet in `docs/design.md` with the resize behavior.

**Step 6:** Run `npm run test:ci`, `npm run typecheck`, `npm run lint`, and `npm run build`.

**Step 7:** Commit the implementation and documentation.
