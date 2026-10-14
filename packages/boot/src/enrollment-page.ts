import { assertionHeader } from "@comms/protocol/headers";
export const escape = (value: string) =>
	value.replace(/[&<>"']/g, (character) =>
		character === "&"
			? "&amp;"
			: character === "<"
				? "&lt;"
				: character === ">"
					? "&gt;"
					: character === '"'
						? "&quot;"
						: "&#39;",
	);
/**
 * Where a held approval page sends the human afterwards: a same-origin path only. Control characters are refused
 * because URL parsing strips tabs and newlines, which could turn "/<tab>/host" into a protocol-relative URL.
 */
export const approvalReturn = (value: string | null, origin: string) => {
	if (
		value === null ||
		value.length > 1024 ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		// oxlint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
		/[\u0000-\u001f\u007f]/.test(value)
	)
		return null;
	const target = URL.parse(value, origin);
	// Dot segments can collapse "/.//host" into "//host" after the prefix check above.
	return target?.origin === origin && !target.pathname.startsWith("//")
		? `${target.pathname}${target.search}${target.hash}`
		: null;
};
const buttons = `<button type="submit" value="approve">Approve with passkey</button><button type="submit" value="deny">Deny with passkey</button>`;
/** A held enrollment is described only from its own row: the extension, agent and label boot stored. */
const heldBody = (
	enrollment: {
		readonly id: string;
		readonly name: string;
		readonly host: string;
		readonly status: string;
		readonly user_code: string;
	},
	extension: string,
	requested: readonly string[],
	returnTo: string | null,
) => `<h1>Allow ${escape(extension)} to act as ${escape(enrollment.name)}</h1>
<p>Extension <strong>${escape(extension)}</strong> asks to act as agent <strong>${escape(enrollment.name)}</strong> (${escape(enrollment.host)}). Boot keeps this access; it is never sent to the extension.</p>
<p>Confirm this code matches the one the extension showed you:</p><p><code>${escape(enrollment.user_code)}</code></p>
<p>Anything the board's app runs can use this access, including code an agent with fs installs later. Revoking that agent does not revoke this grant; revoke the grant itself.</p>
${
	enrollment.status === "pending"
		? `<form id="approval" data-id="${escape(enrollment.id)}" data-base="read"${returnTo === null ? "" : ` data-return="${escape(returnTo)}"`}><p>Grant read access.</p>${requested.includes("write") ? `<label><input id="write" type="checkbox" checked> Allow posting and editing messages, topics and metadata (write)</label>` : ""}${requested.includes("fs") ? `<label><input id="fs" type="checkbox"> Allow source and page editing (fs)</label><p>With fs, anything running in the app, including code another fs agent installs, can act as ${escape(enrollment.name)} and change the app itself.</p>` : ""}<p>Access lasts 90 days, then the extension must ask again. Revoke it at any time from your account.</p>${buttons}</form>`
		: `<p>This request is ${escape(enrollment.status)}. Return to the extension.</p>`
}`;
export const approvalPage = (
	enrollment: {
		readonly id: string;
		readonly name: string;
		readonly kind: string;
		readonly host: string;
		readonly user_code: string;
		readonly status: string;
		readonly held: string | null;
		readonly requested: readonly string[] | null;
	},
	returnTo: string | null = null,
) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve agent · chirp</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:30rem;margin:8vh auto;padding:1.5rem;color:#20251f;background:#f5f5ef}h1{line-height:1.2;overflow-wrap:anywhere}button{font:inherit;padding:.7rem;margin:.7rem .3rem 0 0;border:0;background:#244933;color:white;border-radius:.35rem}button:disabled{opacity:.5}label{display:block;margin:.8rem 0}code{font-size:1.7rem;letter-spacing:.2em}#status{min-height:3em}</style>
<main><p>chirp</p>${
	enrollment.held !== null
		? heldBody(enrollment, enrollment.held, enrollment.requested ?? [], returnTo)
		: `<h1>Connect ${escape(enrollment.name)}@${escape(enrollment.host)}</h1><p>${escape(enrollment.kind)} wants access to this board.</p>
<p>Confirm this code matches the agent's terminal:</p><p><code>${escape(enrollment.user_code)}</code></p>
${enrollment.status === "pending" ? `<form id="approval" data-id="${escape(enrollment.id)}" data-base="read,write"><p>Grant read and write access.</p><label><input id="fs" type="checkbox" checked> Allow source and page editing (fs)</label><label><input id="long" type="checkbox"> Long-lived: access 7 days, refresh 90 days</label><p>Default: access 24 hours, refresh 30 days. Active agents refresh their credentials without another approval.</p>${buttons}</form>` : `<p>This enrollment is ${escape(enrollment.status)}. Return to your agent.</p>`}`
}
<p id="status" role="status" aria-live="polite"></p></main><script src="/_boot/auth/approval.js" defer></script></html>`;
export const approvalClient = `(() => {
 const form = document.getElementById("approval"), status = document.getElementById("status");
 if (!form) return;
 const decode = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
 const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");
 const post = async (path, body, headers = {}) => {
  const response = await fetch(path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code === "enrollment_decided" ? "This enrollment was already decided. Return to your agent." : result.error?.code === "enrollment_expired" ? "This enrollment expired. Ask the agent to enroll again." : "Approval failed. Check this enrollment and try again.");
  return result;
 };
 form.addEventListener("submit",async event => {
  event.preventDefault(); const buttons = form.querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
  status.textContent = "Waiting for your passkey…";
  try {
   const decision = event.submitter.value === "deny" ? "deny" : "approve";
   const checked = id => { const input = document.getElementById(id); return !!input && input.checked; };
   const params = {id:form.dataset.id,decision,scopes:decision === "approve" ? [...(form.dataset.base || "read,write").split(","),...(checked("write") ? ["write"] : []),...(checked("fs") ? ["fs"] : [])] : [],long_lived:decision === "approve" && checked("long")};
   const started = await post("/_boot/auth/challenge",{action:"enrollment.decide",params});
   const options = started.options; options.challenge = decode(options.challenge);
   options.allowCredentials = (options.allowCredentials || []).map(item => ({...item,id:decode(item.id)}));
   const credential = await navigator.credentials.get({publicKey:options});
   if (!credential) throw new Error("No passkey was returned. Try again.");
   const r = credential.response;
   const response = {id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:encode(r.clientDataJSON),authenticatorData:encode(r.authenticatorData),signature:encode(r.signature),...(r.userHandle ? {userHandle:encode(r.userHandle)} : {})}};
   const proof = encode(new TextEncoder().encode(JSON.stringify({id:started.id,response})));
   await post("/_boot/enroll/"+params.id+"/approve",{decision,scopes:params.scopes,long_lived:params.long_lived},{"${assertionHeader}":proof});
   form.hidden = true; status.textContent = decision === "approve" ? "Approved. Return to your agent to collect its credentials." : "Denied. No credentials will be issued.";
   if (form.dataset.return) { const target = new URL(form.dataset.return, location.origin); if (target.origin === location.origin) location.assign(target.href); }
  } catch(error) { status.textContent = error instanceof Error ? error.message : "Approval failed."; }
  finally { buttons.forEach(button => button.disabled = false); }
 });
})();`;
