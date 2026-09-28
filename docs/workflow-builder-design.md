# Workflow Builder: expanded canvas

Selected option A: give the block palette and Start card more room and show input mappings inside each workflow card. Capability cards read left to right: inputs, simple settings, then outputs. Clicking a card opens a modal with connections, advanced configuration, and keyboard alternatives. The canvas scroll wheel zooms; dragging the background pans.

The three original experiments are preserved in local branch `archive/workflow-builder-options`, at `apps/console/src/workflows/workflow-builder.prototype.md`. The originating request and selection were made in the implementation conversation; no separate issue was supplied.

The working Builder uses the existing expression editors, source eligibility rules, change history, and document updates. Layout and card controls do not change workflow execution semantics. Saved layouts retain their coordinates; Arrange spreads older compact layouts to the new card spacing.
