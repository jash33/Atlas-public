Overwrites version.irHash with an arbitrary value that does not match the recomputed hash of the document's own executable content.
Expected diagnostic: compileError TICKET_007_STRUCTURAL_INVALID at version.irHash (this pipeline's own recompute-and-compare stage, not Ticket 007's validator, is what catches this).
