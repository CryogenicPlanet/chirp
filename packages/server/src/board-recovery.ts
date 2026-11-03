/** The actual recovery UI belongs to boot and remains available after this child stops. The server cannot import
 * boot, so this page carries its own copy of the look of boot's operator screens. */
// "chirp" in Pixelify Sans 600, drawn as a path because these pages load no fonts.
const wordmark =
	`<svg width="60" height="20" viewBox="0 0 2506 817" role="img" aria-label="chirp">` +
	`<path fill="#202a3a" d="M89 647V561H0V262H89V175H385V262H475V385H356V299H118V523H356V436H475V561H385V647ZM597 647V0H715V262H774V175H982V262H1072V647H953V299H804V385H715V647ZM1194 647V175H1312V647ZM1194 125V0H1312V125ZM1434 647V262H1523V175H1819V262H1909V385H1790V299H1552V647ZM2031 817V262H2120V175H2416V262H2506V561H2416V647H2149V817ZM2149 523H2387V299H2149Z"/></svg>`;
const bird =
	`<svg width="31" height="28" viewBox="0 0 88 80" shape-rendering="crispEdges" aria-hidden="true">` +
	`<path fill="#ed9b83" d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z"/>` +
	`<path fill="#b9b0df" d="M24 32h8v8h16v8H24z"/><path fill="#ffd166" d="M64 24h16v8H64z"/>` +
	`<path fill="#202a3a" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z"/></svg>`;
const styles = `
*{box-sizing:border-box}html{background:#f7f5f0}body{margin:0;padding-bottom:48px;background:#f7f5f0;color:#202a3a;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid #202a3a;outline-offset:3px}header{padding:24px max(16px,calc(50% - 232px))}
.brand{display:inline-flex;align-items:center;gap:8px;color:#202a3a;font-size:24px;font-weight:650;letter-spacing:-.035em;line-height:28px;text-decoration:none;border-radius:4px}
main{width:min(464px,calc(100% - 32px));margin:0 auto;padding:32px;background:#fff;border-radius:20px;box-shadow:0 0 0 1px rgb(32 42 58/.07),0 1px 3px rgb(32 42 58/.06),0 6px 16px -6px rgb(32 42 58/.08)}
h1{margin:0 0 12px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-.03em;text-wrap:balance}p{margin:0 0 16px;color:#3a4558;text-wrap:pretty}
form{margin:24px 0 0}button{width:100%;min-height:44px;padding:10px 16px;border:0;border-radius:10px;background:#202a3a;color:#fff;font:inherit;font-size:15px;font-weight:500;cursor:pointer}button:hover{background:#3a4558}
.aside{display:flex;flex-wrap:wrap;gap:4px 16px;width:min(464px,calc(100% - 32px));margin:20px auto 0;padding:0 4px;font-size:14px}.aside a{color:#5c6577;text-decoration-color:rgb(92 101 119/.35);text-underline-offset:3px}.aside a:hover{color:#202a3a}
@media(max-width:600px){header{padding-top:16px}main{padding:24px 20px}h1{font-size:26px}}
`;
export const boardRecovery = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>chirp recovery</title>
<link rel="icon" href="/favicon.svg"><style>${styles}</style>
<header><a class="brand" href="/">${bird}${wordmark}</a></header>
<main><h1>Board build unavailable</h1><p>Open immutable recovery to revert the last app source change. Messages, pages and identities are preserved.</p>
<form action="/_boot/recovery" method="get"><button>Revert last source change…</button></form></main>
<p class="aside"><a href="/auth/login">Sign in with a passkey</a><a href="/_boot">Recovery help</a></p></html>`;
