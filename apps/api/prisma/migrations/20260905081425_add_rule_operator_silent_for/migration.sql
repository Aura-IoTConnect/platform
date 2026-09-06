-- New rule shape for "device stopped reporting" (see CLAUDE.md's "Device
-- silence" section) — the one rule type that isn't evaluated per-reading,
-- since there's no reading to react to. threshold is minutes of silence;
-- metric is which metric's absence to watch, same per-metric scoping as
-- every other rule.
ALTER TYPE "rule_operator" ADD VALUE 'SILENT_FOR';
