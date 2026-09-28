import { Data, Effect } from "effect";

export interface MigrationMetadata {
	readonly id: number;
	readonly name: string;
	readonly compatibleSchemaVersions: ReadonlyArray<number>;
	readonly acceptedCompatibleSchemaVersions?: ReadonlyArray<ReadonlyArray<number>>;
}

export class CloudMigrationError extends Data.TaggedError("CloudMigrationError")<{
	readonly message: string;
}> {}

export const validateMigrationLedger = (
	registry: ReadonlyArray<MigrationMetadata>,
	applied: ReadonlyArray<MigrationMetadata>,
) =>
	Effect.gen(function* () {
		const imageVersion = registry.at(-1)?.id ?? 0;
		const sameVersions = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
			left.length === right.length && left.every((version, index) => version === right[index]);
		const validVersions = (entry: MigrationMetadata, versions: ReadonlyArray<number>) =>
			!versions.some(
				(version, position) =>
					!Number.isSafeInteger(version) ||
					version < 1 ||
					version >= entry.id ||
					version <= (versions[position - 1] ?? 0),
			);
		for (const [label, entries] of [
			["registry", registry],
			["ledger", applied],
		] as const) {
			for (const [index, entry] of entries.entries()) {
				if (
					entry.id !== index + 1 ||
					entry.name.length === 0 ||
					!validVersions(entry, entry.compatibleSchemaVersions) ||
					(entry.acceptedCompatibleSchemaVersions ?? []).some(
						(versions, acceptedIndex, accepted) =>
							!validVersions(entry, versions) ||
							sameVersions(versions, entry.compatibleSchemaVersions) ||
							accepted.slice(0, acceptedIndex).some((earlier) => sameVersions(versions, earlier)),
					)
				)
					return yield* new CloudMigrationError({
						message: `Cloud schema ${imageVersion}: invalid migration ${label} at version ${entry.id}`,
					});
			}
		}
		for (const receipt of applied) {
			const expected = registry[receipt.id - 1];
			if (expected) {
				if (
					receipt.name !== expected.name ||
					![expected.compatibleSchemaVersions, ...(expected.acceptedCompatibleSchemaVersions ?? [])].some((versions) =>
						sameVersions(receipt.compatibleSchemaVersions, versions),
					)
				)
					return yield* new CloudMigrationError({
						message: `Cloud schema ${imageVersion}: migration ${receipt.id} receipt does not match the immutable registry`,
					});
			} else if (!receipt.compatibleSchemaVersions.includes(imageVersion)) {
				return yield* new CloudMigrationError({
					message: `Cloud schema ${imageVersion}: newer migration ${receipt.id} does not explicitly declare this image compatible; deploy a compatible image`,
				});
			}
		}
	});
