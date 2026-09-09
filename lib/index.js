// dsh-artifacts node half.
//
// This file deliberately imports NOTHING and registers NOTHING.
//
// Why it still has to exist: the client-modules host scan reads the
// `dsh.client` declaration from packages mounted in the host Loader, so the
// browser half is only served if this package is mounted by a cordis row. That
// is the same reason dsh-model-picker-augmented keeps a near-empty node half.
//
// Why it imports nothing: this profile has been taken down before by exactly
// that mistake. Two github: plugins imported `installSettingsSection` /
// `settingsNamespace` from @deepseek-ai/dsh-settings@0.1.2-rc.1, which does not
// export them; the ESM import became a hard SyntaxError at load, the loader
// entry threw, and dsh exited 1 before boot finished -- hundreds of restarts
// and the whole GUI down. A zero-import host half cannot fail that way.
//
// All artifact data reaches the browser over HTTP from the index endpoint
// (default `/report/?list=1`, contract in docs/artifact-index-endpoint.md), so
// this half needs no service, no settings namespace, and no filesystem access
// of its own.

export const name = 'dsh-artifacts'

// Empty on purpose: an unsatisfied `inject` leaves the entry pending forever
// and boot fails on "1 entry did not activate" (that is how
// @dsh-external/dsh-deep-research broke this profile). This half waits on
// nothing.
export const inject = []

export function apply() {
  // Nothing to do on the host plane. Kept as a no-op because the loader
  // expects a plugin face.
}
