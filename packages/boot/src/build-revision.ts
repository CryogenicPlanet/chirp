import { Effect, FileSystem } from "effect";

/** The image build writes the commit beside boot's bundle (packages/boot/dist/revision); a source checkout has none. */
const revisionFile = decodeURIComponent(new URL("./revision", import.meta.url).pathname);

/** A commit, or null for anything else, so a board never claims a version it cannot prove. */
export const parseRevision = (text: string) => {
	const value = text.trim();
	return /^[0-9a-f]{7,40}$/.test(value) ? value : null;
};

/**
 * The commit this image was built from. It is read from a file baked into the image, never from the environment,
 * so a deployment variable cannot change what the board reports.
 */
export const readRevision = (path: string) =>
	FileSystem.FileSystem.pipe(
		Effect.flatMap((fs) => fs.readFileString(path)),
		Effect.map(parseRevision),
		Effect.orElseSucceed(() => null),
	);

export const buildRevision = readRevision(revisionFile);
