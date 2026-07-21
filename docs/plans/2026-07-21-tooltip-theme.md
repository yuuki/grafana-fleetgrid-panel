# Theme-aware Tooltip Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the cell tooltip readable in both Grafana light and dark themes.

**Architecture:** Keep `CellTooltip` as an inline-styled overlay and source its surface, text, border, and shadow values from `useTheme2()`. Preserve metric swatches and tooltip behavior.

**Tech Stack:** React, TypeScript, Grafana UI theme API, Jest, React Testing Library

---

### Task 1: Theme the tooltip

**Files:**
- Modify: `src/components/CellTooltip.tsx`
- Test: `src/components/CellTooltip.test.tsx`
- Modify: `docs/design.md`

**Step 1:** Add a test asserting that the tooltip uses the current theme's elevated/secondary background, primary text, medium border, and z3 shadow rather than fixed dark colors.

**Step 2:** Run `npm run test:ci -- src/components/CellTooltip.test.tsx` and confirm the new assertion fails for the fixed colors.

**Step 3:** Read the theme with `useTheme2()` and apply only the requested surface styles.

**Step 4:** Re-run the focused test and confirm it passes.

**Step 5:** Replace the corresponding known-limitation bullet in `docs/design.md` with a short resolved design decision.

**Step 6:** Run `npm run test:ci`, `npm run typecheck`, `npm run lint`, and `npm run build`.

**Step 7:** Commit the implementation and documentation.
