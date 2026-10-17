# Desktop design direction

The visual thesis is a dense, quiet coding cockpit: high signal, low chrome,
clear task state, and enough surrounding context to make an agent run legible
without turning the product into a generic dashboard.

## Current language

- Graphite surfaces with one accent color, white by default, that the person
  can change in Settings.
- A three-part workspace: project/thread rail, task timeline, and context
  inspector.
- Timeline entries are the primary object. Tool activity, diffs, approvals,
  and verification sit in the same causal sequence.
- Status uses text plus color and icon; color is never the only indicator.
- Keyboard-first actions: command palette, composer shortcuts, focusable rails,
  and visible shortcut hints.
- Responsive collapse keeps the timeline usable when the inspector cannot fit.

Visual changes should be intentional, reviewable, and tested against the
product thesis above.

## UI quality gates

- Every interactive control has a visible state for disabled, loading, failed,
  disconnected, and approval-required conditions.
- Empty states explain what the user can do next; they do not fabricate usage
  data or task counts.
- Long titles, paths, tool names, and model names remain bounded and readable.
- Focus rings, contrast, reduced motion, and keyboard traversal are verified.
- Visual polish never hides the authoritative source of task state.
