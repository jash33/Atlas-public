# Compensation replay histories

These histories were captured from the unchanged interpreter at `c5b3d13`, using the
`compensates uncertain writes` regression test with a lost response in IR versions 2 and 3.
That interpreter skipped the undo activity. Replay must preserve its recorded decisions.

All inputs and provider failures are synthetic. The payload key is the fixed test key in
`interpreter.test.ts`, not a deployment credential. Files use the SDK's protobuf object JSON
format and are read with `History.fromObject` before replay.
