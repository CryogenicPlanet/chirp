import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ecKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

/** A throwaway CA and one leaf certificate per DNS name, made with openssl in a temporary directory. */
export const testCertificates = async (names: ReadonlyArray<string>) => {
	const directory = await mkdtemp(join(tmpdir(), "signin-tls-"));
	const openssl = (args: ReadonlyArray<string>) => run("openssl", args, { cwd: directory });
	await openssl([
		"req",
		"-x509",
		...ecKey,
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"1",
		"-subj",
		"/CN=chirp signin test CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign",
	]);
	const leaves = new Map<string, { key: Buffer; cert: Buffer }>();
	for (const name of names) {
		await openssl(["req", ...ecKey, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
		await writeFile(
			join(directory, `${name}.ext`),
			`subjectAltName=DNS:${name}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
		);
		await openssl([
			"x509",
			"-req",
			"-in",
			`${name}.csr`,
			"-CA",
			"ca.pem",
			"-CAkey",
			"ca.key",
			"-CAcreateserial",
			"-out",
			`${name}.pem`,
			"-days",
			"1",
			"-extfile",
			`${name}.ext`,
		]);
		leaves.set(name, {
			key: await readFile(join(directory, `${name}.key`)),
			cert: await readFile(join(directory, `${name}.pem`)),
		});
	}
	return {
		ca: join(directory, "ca.pem"),
		leaf: (name: string) => {
			const leaf = leaves.get(name);
			if (!leaf) throw new Error(`No test certificate for ${name}`);
			return leaf;
		},
		remove: () => rm(directory, { recursive: true, force: true }),
	};
};
