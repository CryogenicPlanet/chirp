import { DateTime, Effect, Ref } from "effect";
import { describe, expect, test } from "vitest";
import type { InvitationIdentity, InvitationPolicyDependencies } from "../src/invitation-policy.ts";
import { checkInvitation } from "../src/invitation-policy.ts";

const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const now = DateTime.toDateUtc(DateTime.makeUnsafe(0));

const identity = (overrides: Partial<InvitationIdentity> = {}): InvitationIdentity => ({
	user: { email: "Person@Example.COM", emailVerified: true },
	source: { action: "create-user", method: "oauth" },
	...overrides,
});

describe("invitation policy", () => {
	test("admits returning sign-ins and explicit account links without consuming an invitation", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const consumed = yield* Ref.make(0);
				const dependencies: InvitationPolicyDependencies = {
					readToken: Effect.succeed(token),
					digest: () => Effect.succeed("digest"),
					now: Effect.succeed(now),
					consume: () => Ref.update(consumed, (value) => value + 1).pipe(Effect.as(true)),
				};
				expect(yield* checkInvitation(identity({ source: { action: "sign-in", method: "oauth" } }), dependencies)).toBe(
					undefined,
				);
				expect(
					yield* checkInvitation(identity({ source: { action: "link-account", method: "oauth" } }), dependencies),
				).toBe(undefined);
				expect(yield* Ref.get(consumed)).toBe(0);
			}),
		);
	});

	test("rejects non-OAuth, unverified, malformed, and unclaimable sign-ups", async () => {
		const dependencies = (candidate: unknown, consume: boolean): InvitationPolicyDependencies => ({
			readToken: Effect.succeed(candidate),
			digest: () => Effect.succeed("digest"),
			now: Effect.succeed(now),
			consume: () => Effect.succeed(consume),
		});
		expect(
			(
				await Effect.runPromise(
					checkInvitation(
						identity({ source: { action: "create-user", method: "email-password" } }),
						dependencies(token, true),
					),
				)
			)?.error,
		).toBe("invitation_required");
		expect(
			(
				await Effect.runPromise(
					checkInvitation(
						identity({ user: { email: "person@example.com", emailVerified: false } }),
						dependencies(token, true),
					),
				)
			)?.error,
		).toBe("verified_email_required");
		expect((await Effect.runPromise(checkInvitation(identity(), dependencies("short", true))))?.error).toBe(
			"invitation_required",
		);
		expect((await Effect.runPromise(checkInvitation(identity(), dependencies(token, false))))?.error).toBe(
			"invitation_invalid",
		);
	});

	test("normalizes the verified email and consumes the matching token digest", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const claimed = yield* Ref.make<unknown>(undefined);
				const result = yield* checkInvitation(identity(), {
					readToken: Effect.succeed(token),
					digest: (value) => Effect.succeed(`digest:${value}`),
					now: Effect.succeed(now),
					consume: (claim) => Ref.set(claimed, claim).pipe(Effect.as(true)),
				});
				expect(result).toBeUndefined();
				expect(yield* Ref.get(claimed)).toEqual({
					tokenDigest: `digest:${token}`,
					email: "person@example.com",
					after: now,
				});
			}),
		);
	});
});
