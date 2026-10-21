# ofm-rate-limit-retry

Retries `RATE_LIMIT` and `UNKNOWN` on both provider routes of `dsh-our-free-model`.

This is a dsh-side patch: it wraps the retry policy at the composition layer and does **not** modify any byte of the plugin it patches. `dsh-our-free-model` stays untouched and can keep moving independently.

## Wiring

Bundle patch: `cordis.patch.yml`, single entry point `index.js`.

## Requirements

Enable `dsh-our-free-model` alongside this one; the wrapper only has effect when the patched plugin is present.
