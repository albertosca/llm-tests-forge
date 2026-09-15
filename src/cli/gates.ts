import { ForgeError } from "../core/errors";
import type { Feature } from "../core/schemas";

/**
 * The spec's downstream gate: "Nothing downstream runs while
 * `feature.yaml` is `pending`." Every verb that reads the feature in order
 * to act on it — `scenarios`, `cases`, `import` — calls this, and it lives
 * here rather than being repeated in each command so a fourth consumer
 * cannot forget it. `review` is deliberately not a caller: reviewing a
 * pending feature is how it stops being pending.
 */
export function requireApprovedFeature(feature: Feature, file: string): void {
	if (feature.status === "pending")
		throw new ForgeError("feature is pending; run `forge review` first", {
			file,
			id: feature.id,
		});
}
