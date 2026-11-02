import { mysqlIndexedParts, type MysqlSearchConfig } from "./mysql-search-config.ts";
import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { Constructor, Fragment } from "effect/unstable/sql/Statement";
import { KernelError } from "../../kernel/boot-channel.ts";

// Regular English plurals, tried in order. Where a suffix is ambiguous (movies, policies; sizes, boxes) every
// candidate is kept: a form that is not a real word matches nothing.
const plurals: ReadonlyArray<readonly [RegExp, (word: string) => ReadonlyArray<string>]> = [
	[/ies$/i, (word) => [`${word.slice(0, -3)}y`, word.slice(0, -1)]],
	[/(?:ss|x|z|ch|sh)es$/i, (word) => [word.slice(0, -2), word.slice(0, -1)]],
	[/(?:ss|us|is)$/i, (word) => [`${word}es`]],
	[/s$/i, (word) => [word.slice(0, -1)]],
	[/[^aeiou]y$/i, (word) => [`${word.slice(0, -1)}ies`]],
	[/(?:x|z|ch|sh)$/i, (word) => [`${word}es`]],
	[/$/, (word) => [`${word}s`]],
];

/**
 * An unquoted English word of four or more letters also matches its regular singular or plural, so list finds
 * lists and the reverse. Quoted phrases, short words and anything else match as written.
 */
export const wordForms = (part: string): ReadonlyArray<string> => {
	const rule = /^[a-z]{4,}$/i.test(part) ? plurals.find(([pattern]) => pattern.test(part)) : undefined;
	return rule ? [part, ...rule[1](part).filter((form) => form.length >= 3)] : [part];
};

/** Parse once; caller text remains bound data, never SQL or search operators. */
export const searchMessages = (
	sql: Constructor,
	query: string,
	ceiling: number,
	folding = false,
	mysql: MysqlSearchConfig | null = null,
) =>
	Effect.gen(function* () {
		const parts = query.trim().match(/"[^"]*"|[^\s"]+/gu) ?? [];
		if (
			query.length > 512 ||
			query.includes("\0") ||
			parts.length === 0 ||
			parts.length > 16 ||
			query.replace(/"[^"]*"|[^\s"]+|\s+/gu, "") !== "" ||
			parts.some((part) => !/[\p{L}\p{N}]/u.test(part))
		)
			return yield* new KernelError({ code: "query_invalid" });

		const exact = (part: string) => part.startsWith('"');
		const sanitized = parts.map((part) => part.replace(/[+\-><()~*"@]/gu, " ").trim());
		const indexed = mysql ? yield* mysqlIndexedParts(sql, sanitized, mysql) : sanitized;
		return on(sql, {
			sqlite: () => {
				// unicode61 already splits hyphenated words, inside phrases as in the index.
				const quote = (text: string) => `"${text.replaceAll('"', "")}"`;
				const expression = parts
					.map((part) => {
						const forms = exact(part) ? [part] : wordForms(part);
						return forms.length === 1 ? quote(part) : `(${forms.map(quote).join(" OR ")})`;
					})
					.join(" AND ");
				return sql`id IN (
				 SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
				 WHERE messages_fts MATCH ${`body : (${expression})`} AND messages.updated_seq<=${ceiling}
				 UNION
				 SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
				 WHERE messages_fts MATCH ${`previous_body : (${expression})`} AND messages.updated_seq>${ceiling}
				)`;
			},
			pg: () => {
				const text = (value: string) => (folding ? sql`public.comms_unaccent(${value})` : sql`${value}`);
				// The simple parser indexes reading-list as one token plus its parts, but keeps dates, versions, hosts
				// and paths whole. A hyphen-joined term matches as written or as the phrase of its parts, so it finds
				// both "reading list" and "reading-list" and still finds 2024-01-05 or utf-8.
				const spaced = (value: string) => value.replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, " ");
				const phrase = (value: string) => sql`phraseto_tsquery('simple',${text(value)})`;
				const plain = (value: string) => sql`plainto_tsquery('simple',${text(value)})`;
				const either = (left: Fragment, right: Fragment) => sql`(${left} || ${right})`;
				const hyphenated = (value: string, written: Fragment) =>
					spaced(value) === value ? written : either(written, phrase(spaced(value)));
				const expression = parts
					.map((part) =>
						exact(part)
							? hyphenated(part.slice(1, -1), phrase(part.slice(1, -1)))
							: spaced(part) !== part
								? hyphenated(part, plain(part))
								: wordForms(part).map(plain).reduce(either),
					)
					.reduce((left, right) => sql`(${left} && ${right})`);
				return sql`id IN (SELECT id FROM messages WHERE
				 (updated_seq<=${ceiling} AND body_tsv @@ ${expression}) OR
				 (updated_seq>${ceiling} AND previous_body_tsv @@ ${expression}))`;
			},
			mysql: () => {
				// Keep phrase words intact: MySQL uses excluded internal words during phrase verification.
				// Quoting each sanitized part also prevents punctuation from becoming Boolean syntax.
				if (indexed.length === 0) return sql`1=1`;
				const expression = sanitized
					.flatMap((part, index) => {
						if (!indexed.includes(part)) return [];
						const raw = parts[index] ?? "";
						const forms = exact(raw) ? [raw] : wordForms(raw);
						return [forms.length === 1 ? `+"${part}"` : `+(${forms.map((form) => `"${form}"`).join(" ")})`];
					})
					.join(" ");
				return sql`id IN (SELECT id FROM messages WHERE
				 (updated_seq<=${ceiling} AND MATCH(body) AGAINST (${expression} IN BOOLEAN MODE)) OR
				 (updated_seq>${ceiling} AND MATCH(previous_body) AGAINST (${expression} IN BOOLEAN MODE)))`;
			},
		});
	});
